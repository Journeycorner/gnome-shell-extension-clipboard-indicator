// @ts-nocheck

/*
 * Clipboard Indicator main entry point.
 *
 * This module wires the GNOME Shell extension lifecycle to the clipboard
 * history UI. It runs under GJS, so modules are pulled from GNOME's platform
 * libraries and the Shell runtime. The indicator itself lives on the panel and
 * mirrors clipboard changes inside a popup history menu.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AnimationUtils from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Registry, ClipboardEntry} from './registry.js';
import {PrefsFields} from './constants.js';
import {Keyboard} from './keyboard.js';

// Preferences cached from schema; they are mutated via _loadSettings.
const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;

const INDICATOR_ICON = 'edit-paste-symbolic';

// Extension lifecycle entry: registers the panel button and cleans it up on
// disable. The heavy lifting lives in the ClipboardIndicator class below.
export default class ClipboardIndicatorExtension extends Extension {
    enable() {
        this.clipboardIndicator = new ClipboardIndicator({
            clipboard: St.Clipboard.get_default(),
            settings: this.getSettings(),
            openSettings: this.openPreferences,
            uuid: this.uuid
        });

        Main.panel.addToStatusArea('clipboardIndicator', this.clipboardIndicator, 1);
    }

    disable() {
        this.clipboardIndicator.destroy();
        this.clipboardIndicator = null;
    }
}

// PanelMenu.Button subclass that renders the indicator, popup history, and all
// clipboard interactions.
const ClipboardIndicator = GObject.registerClass({
    GTypeName: 'ClipboardIndicator'
}, class ClipboardIndicator extends PanelMenu.Button {
    destroy() {
        this._disconnectSettings();
        this._unbindShortcuts();
        this._disconnectSelectionListener();
        this._clearDelayedSelectionTimeout();
        this._clearTimeouts();
        this._stopScreenShareWatcher();
        this._keyboard.destroy();
        this._clipItems = [];

        super.destroy();
    }

    // Build the visible button, wire up settings, and kick off history loading.
    _init(extension) {
        super._init(0.0, "ClipboardIndicator");
        this._clipboard = extension.clipboard;
        this._settings = extension.settings;
        this._registry = new Registry({settings: this._settings, uuid: extension.uuid});
        this._keyboard = new Keyboard();

        this._refreshInProgress = false;
        this._notifSource = null;
        this._screenShareWatchId = 0;
        this._screenShareSignalIds = [];
        this._settingsChangedId = 0;
        this._selection = null;
        this._selectionOwnerChangedId = 0;
        this._setFocusOnOpenTimeout = null;
        this._imagePreviewTimeout = null;
        this._pastingKeypressTimeout = null;
        this._pastingResetTimeout = null;
        this._delayedSelectionTimeoutId = null;

        this._clipItems = [];
        this._icon = null;
        this._buttonText = null;
        this._buttonImgPreview = null;
        this._downArrow = null;
        this._historySection = null;
        this._historyScrollView = null;
        this._scrollViewMenuSection = null;
        this._emptyStateSection = null;
        this._shortcutBindingIds = [];
        this._hbox = null;

        this._preventIndicatorUpdate = false;
        this._privateMode = false;

        this._delayedSelectionTimeout = 750;
        this._maxRegistryLength = 15;
        this._maxEntryLength = 50;
        this._cacheOnlyFavorite = false;
        this._moveItemFirst = false;
        this._enableKeybinding = true;
        this._notifyOnCopy = true;
        this._notifyOnCycle = true;
        this._maxTopbarLength = 15;
        this._clearOnBoot = false;
        this._disableDownArrow = false;
        this._stripText = false;
        this._cacheImages = false;
        this._excludedApps = [];
        this._pasteButtonSetting = false;
        this._pinnedOnBottom = false;

        const hbox = new St.BoxLayout({
            style_class: 'panel-status-menu-box clipboard-indicator-hbox'
        });
        this._hbox = hbox;

        this._icon = new St.Icon({
            icon_name: INDICATOR_ICON,
            style_class: 'system-status-icon clipboard-indicator-icon'
        });

        this._buttonText = new St.Label({
            text: _('Text will be here'),
            y_align: Clutter.ActorAlign.CENTER
        });

        this._buttonImgPreview = new St.Bin({
            style_class: 'clipboard-indicator-topbar-preview'
        });

        hbox.add_child(this._icon);
        hbox.add_child(this._buttonText);
        hbox.add_child(this._buttonImgPreview);
        this._downArrow = PopupMenu.arrowIcon(St.Side.BOTTOM);
        hbox.add_child(this._downArrow);
        this.add_child(hbox);
        this._loadSettings();

        if (this._clearOnBoot) {
            this._registry.clearCacheFolder();
        }
        // No dialog manager
        this._buildMenu().then(() => {
            this._updateTopbarLayout();
            this._setupListener();
            this._startScreenShareWatcher();
        });
    }

    // Sync the panel button preview with the newest clipboard entry.
    _updateIndicatorContent(entry) {
        if (this._preventIndicatorUpdate) {
            return;
        }

        this._buttonImgPreview.destroy_all_children();
        this._buttonText.set_text('');
    }

    // Populate the popup with existing registry entries and set up sections.
    async _buildMenu() {
        const clipHistory = await this._getCache();
        const lastIdx = clipHistory.length - 1;

        this.menu.connect('open-state-changed', (_self, open) => {
            this._setFocusOnOpenTimeout = setTimeout(() => {
                if (open) {
                    this._focusFirstVisibleItem();
                }
            }, 50);
        });

        // Create menu section for history items
        this._historySection = new PopupMenu.PopupMenuSection();

        this._scrollViewMenuSection = new PopupMenu.PopupMenuSection();
        this._historyScrollView = new St.ScrollView({
            style_class: 'ci-main-menu-section ci-history-menu-section',
            overlay_scrollbars: true
        });
        this._historyScrollView.add_child(this._historySection.actor);

        this._scrollViewMenuSection.actor.add_child(this._historyScrollView);
        this.menu.addMenuItem(this._scrollViewMenuSection);

        // Removed bottom links: Private mode, Clear history, Settings

        // Empty state section
        this._emptyStateSection = new St.BoxLayout({
            style_class: 'clipboard-indicator-empty-state',
            vertical: true
        });
        this._emptyStateSection.add_child(new St.Icon({
            icon_name: INDICATOR_ICON,
            style_class: 'system-status-icon clipboard-indicator-icon',
            x_align: Clutter.ActorAlign.CENTER
        }));
        this._emptyStateSection.add_child(new St.Label({
            text: _('Clipboard is empty'),
            x_align: Clutter.ActorAlign.CENTER
        }));

        // Add cached items
        clipHistory.forEach(entry => this._addEntry(entry));

        if (lastIdx >= 0) {
            this._selectMenuItem(this._clipItems[lastIdx]);
        }

        this._showElements();
    }

    _hideElements() {
        if (this.menu.box.contains(this._emptyStateSection)) {
            this.menu.box.remove_child(this._emptyStateSection);
        }
    }

    _showElements() {
        if (this._clipItems.length > 0) {
            if (this.menu.box.contains(this._emptyStateSection) === true) {
                this.menu.box.remove_child(this._emptyStateSection);
            }
        } else if (this.menu.box.contains(this._emptyStateSection) === false) {
            this._renderEmptyState();
        }
    }

    _focusFirstVisibleItem() {
        if (this._clipItems.length > 0) {
            const orderedItems = this._historySection._getMenuItems();

            const firstVisible = orderedItems.find(item => item.actor.visible);
            if (firstVisible) {
                firstVisible.actor.grab_key_focus();
                return;
            }
        }

        // No fallback item at bottom
    }

    _renderEmptyState() {
        this._hideElements();
        this.menu.box.insert_child_at_index(this._emptyStateSection, 0);
    }

    _truncate(string, length) {
        let shortened = string.replace(/\s+/g, ' ');

        let chars = [...shortened]
        if (chars.length > length)
            shortened = chars.slice(0, length - 1).join('') + '...';

        return shortened;
    }

    _getEntryText(entry) {
        const value = entry.getStringValue();
        if (this._stripText && typeof value === 'string') {
            return value.trim();
        }
        return value;
    }

    // Render either text or an image preview for a menu item depending on the
    // clipboard entry type.
    _setEntryLabel(menuItem) {
        const {entry} = menuItem;
        if (entry.isText()) {
            menuItem.label.set_text(this._truncate(this._getEntryText(entry), this._maxEntryLength));
        } else if (entry.isImage()) {
            this._registry.getEntryAsImage(entry).then(img => {
                img.add_style_class_name('clipboard-menu-img-preview');
                if (menuItem.previewImage) {
                    menuItem.remove_child(menuItem.previewImage);
                }
                menuItem.previewImage = img;
                menuItem.insert_child_below(img, menuItem.label);
            });
        }
    }

    _findNextMenuItem(currentMenutItem) {
        const currentIndex = this._clipItems.indexOf(currentMenutItem);

        // for only one item
        if (this._clipItems.length === 1) {
            return null;
        }

        // when focus is in middle of the displayed list
        for (let i = currentIndex - 1; i >= 0; i--) {
            const menuItem = this._clipItems[i];
            if (menuItem.actor.visible) {
                return menuItem;
            }
        }

        // when focus is at the last element of the displayed list
        const beforeMenuItem = this._clipItems[currentIndex + 1];
        if (beforeMenuItem.actor.visible) {
            return beforeMenuItem;
        }

        return null;
    }

    _selectNextMenuItem(menuItem) {
        let nextMenuItem = this._findNextMenuItem(menuItem);

        if (nextMenuItem) {
            nextMenuItem.actor.grab_key_focus();
        }
    }

    // Create the popup menu row for a new clipboard entry and install
    // shortcuts/paste actions.
    _addEntry(entry, autoSelect, autoSetClip) {
        let menuItem = new PopupMenu.PopupMenuItem('');

        menuItem.menu = this.menu;
        menuItem.entry = entry;
        menuItem.clipContents = this._getEntryText(entry);
        menuItem.radioGroup = this._clipItems;
        menuItem.buttonPressId = menuItem.connect('activate',
            autoSet => this._onMenuItemSelectedAndMenuClose(menuItem, autoSet));
        menuItem.connect('key-focus-in', () => {
            AnimationUtils.ensureActorVisibleInScrollView(this._historyScrollView, menuItem);
        });
        menuItem.actor.connect('key-press-event', (actor, event) => {
            switch (event.get_key_symbol()) {
                case Clutter.KEY_Delete:
                    this._selectNextMenuItem(menuItem);
                    this._removeEntry(menuItem, 'delete');
                    break;
                case Clutter.KEY_KP_Enter, Clutter.KEY_Return:
                    this._pasteItem(menuItem);
                    this._onMenuItemSelectedAndMenuClose(menuItem, true);
                    break;
            }
        })

        this._setEntryLabel(menuItem);
        this._clipItems.push(menuItem);

        this._historySection.addMenuItem(menuItem, 0);

        if (autoSelect === true) {
            this._selectMenuItem(menuItem, autoSetClip);
        } else {
            menuItem.setOrnament(PopupMenu.Ornament.NONE);
        }

        this._showElements();
    }

    _removeEntry(menuItem, event) {
        const itemIdx = this._clipItems.indexOf(menuItem);

        if (event === 'delete' && menuItem.currentlySelected) {
            this._clearClipboard();
        }

        menuItem.destroy();
        this._clipItems.splice(itemIdx, 1);

        if (menuItem.entry.isImage()) {
            this._registry.deleteEntryFile(menuItem.entry);
        }

        this._updateCache();
        this._showElements();
    }

    _removeOldestEntries() {
        let clipItemsRadioGroupNoFavorite = this._clipItems.filter(
            item => item.entry.isFavorite() === false);

        const origSize = clipItemsRadioGroupNoFavorite.length;

        while (clipItemsRadioGroupNoFavorite.length > this._maxRegistryLength) {
            const oldestNoFavorite = clipItemsRadioGroupNoFavorite.shift();
            this._removeEntry(oldestNoFavorite);

            clipItemsRadioGroupNoFavorite = this._clipItems.filter(
                item => item.entry.isFavorite() === false);
        }

        if (clipItemsRadioGroupNoFavorite.length < origSize) {
            this._updateCache();
        }
    }

    _onMenuItemSelected(menuItem, autoSet) {
        for (let otherMenuItem of menuItem.radioGroup) {
            let clipContents = menuItem.clipContents;

            if (otherMenuItem === menuItem && clipContents) {
                menuItem.setOrnament(PopupMenu.Ornament.NONE);
                menuItem.currentlySelected = true;
                if (autoSet !== false)
                    this._updateClipboard(menuItem.entry);
            } else {
                otherMenuItem.setOrnament(PopupMenu.Ornament.NONE);
                otherMenuItem.currentlySelected = false;
            }
        }
    }

    _selectMenuItem(menuItem, autoSet) {
        this._onMenuItemSelected(menuItem, autoSet);
        this._updateIndicatorContent(menuItem.entry);
    }

    _onMenuItemSelectedAndMenuClose(menuItem, autoSet) {
        for (let otherMenuItem of menuItem.radioGroup) {
            let clipContents = menuItem.clipContents;

            if (menuItem === otherMenuItem && clipContents) {
                menuItem.setOrnament(PopupMenu.Ornament.NONE);
                menuItem.currentlySelected = true;
                if (autoSet !== false)
                    this._updateClipboard(menuItem.entry);
            } else {
                otherMenuItem.setOrnament(PopupMenu.Ornament.NONE);
                otherMenuItem.currentlySelected = false;
            }
        }

        menuItem.menu.close();
    }

    _getCache() {
        return this._registry.read();
    }

    _addToCache(entry) {
        const entries = this._clipItems
            .map(menuItem => menuItem.entry)
            .filter(item => !this._cacheOnlyFavorite || item.isFavorite())
            .concat([entry]);
        this._registry.write(entries);
    }

    _updateCache() {
        const entries = this._clipItems
            .map(menuItem => menuItem.entry)
            .filter(entry => !this._cacheOnlyFavorite || entry.isFavorite());

        this._registry.write(entries);
    }

    async _onSelectionChange(selection, selectionType, selectionSource) {
        if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD) {
            this._refreshIndicator();
        }
    }

    async _refreshIndicator() {
        if (this._privateMode) return; // Private mode, do not.

        const focussedWindow = Shell.Global.get().display.focusWindow;
        const wmClass = focussedWindow?.get_wm_class();

        if (wmClass && this._excludedApps.includes(wmClass)) return; // Excluded app, do not.

        if (this._refreshInProgress) return;
        this._refreshInProgress = true;

        try {
            const result = await this._getClipboardContent();

            if (result) {
                for (const menuItem of this._clipItems) {
                    if (menuItem.entry.equals(result)) {
                        this._selectMenuItem(menuItem, false);

                        if (!menuItem.entry.isFavorite() && this._moveItemFirst) {
                            this._moveItemFirst(menuItem);
                        }

                        return;
                    }
                }

                this._addToCache(result);
                this._addEntry(result, true, false);
                this._removeOldestEntries();
                if (this._notifyOnCopy) {
                    this._showNotification(_("Copied to clipboard"), notif => {
                        notif.addAction(_('Cancel'), this._cancelNotification);
                    });
                }
            }
        } catch (e) {
            console.error('Clipboard Indicator: Failed to refresh indicator');
            console.error(e);
        } finally {
            this._refreshInProgress = false;
        }
    }

    _moveItemFirst(item) {
        this._removeEntry(item);
        this._addEntry(item.entry, item.currentlySelected, false);
        this._updateCache();
    }

    _getCurrentlySelectedItem() {
        return this._clipItems.find(item => item.currentlySelected);
    }

    _getAllIMenuItems() {
        return this._historySection._getMenuItems();
    }

    _setupListener() {
        const metaDisplay = Shell.Global.get().get_display();
        const selection = metaDisplay.get_selection();
        this._setupSelectionTracking(selection);
    }

    _setupSelectionTracking(selection) {
        this._selection = selection;
        this._selectionOwnerChangedId = selection.connect('owner-changed', (selectionObj, selectionType, selectionSource) => {
            this._onSelectionChange(selectionObj, selectionType, selectionSource);
        });
    }

    _initNotifSource() {
        if (!this._notifSource) {
            this._notifSource = new MessageTray.Source({
                title: 'Clipboard Indicator',
                'icon-name': INDICATOR_ICON
            });

            this._notifSource.connect('destroy', () => {
                this._notifSource = null;
            });

            Main.messageTray.add(this._notifSource);
        }
    }

    _cancelNotification() {
        if (this._clipItems.length >= 2) {
            const clipSecond = this._clipItems.length - 2;
            const previousClip = this._clipItems[clipSecond];
            this._updateClipboard(previousClip.entry);
            previousClip.setOrnament(PopupMenu.Ornament.NONE);
            // Delete icon removed; nothing to toggle here
            previousClip.currentlySelected = true;
        } else {
            this._clearClipboard();
        }
        const clipFirst = this._clipItems.length - 1;
        this._removeEntry(this._clipItems[clipFirst]);
    }

    _showNotification(message, transformFn) {
        const dndOn = () =>
            !Main.panel.statusArea.dateMenu._indicator._settings.get_boolean(
                'show-banners',
            );
        if (this._privateMode || dndOn()) {
            return;
        }

        let notification = null;

        this._initNotifSource();

        if (this._notifSource.count === 0) {
            notification = new MessageTray.Notification({
                source: this._notifSource,
                body: message,
                'is-transient': true
            });
        } else {
            notification = this._notifSource.notifications[0];
            notification.body = message;
            notification.clearActions();
        }

        if (typeof transformFn === 'function') {
            transformFn(notification);
        }

        this._notifSource.addNotification(notification);
    }

    _setPrivateMode(state) {
        if (this._privateMode === state) {
            return;
        }

        this._privateMode = state;
        this._onPrivateModeSwitch();
    }

    _onPrivateModeSwitch() {
        // We hide the history in private ModeTypee because it will be out of sync (selected item will not reflect clipboard)
        this._scrollViewMenuSection.actor.visible = !this._privateMode;
        // If we get out of private mode then we restore the clipboard to old state
        if (!this._privateMode) {
            const selectList = this._clipItems.filter(item => !!item.currentlySelected);

            if (selectList.length) {
                this._selectMenuItem(selectList[0]);
            } else {
                // Nothing to return to, let's empty it instead
                this._clearClipboard();
            }

            this._getClipboardContent().then(entry => {
                if (!entry) return;
                this._updateIndicatorContent(entry);
            }).catch(e => console.error(e));

            this._hbox.remove_style_class_name('private-mode');
            this._showElements();
        } else {
            this._hbox.add_style_class_name('private-mode');
            this._updateIndicatorContent(null);
            this._hideElements();
        }
    }

    _loadSettings() {
        this._settingsChangedId = this._settings.connect('changed', () => this._onSettingsChange());

        this._fetchSettings();

        if (this._enableKeybinding)
            this._bindShortcuts();
    }

    // --- Auto private mode on screen sharing ---
    _isScreenSharingActive(): boolean {
        return Main.panel?.statusArea['screenSharing']?.visible;
        // disable for debugging because --devkit enables screensharing indicator
        // return false;
    }

    _startScreenShareWatcher() {
        if (this._screenShareWatchId) return;
        const sync = () => {
            const active = this._isScreenSharingActive();
            // Always reflect current state in private mode
            this._setPrivateMode(active);
            return GLib.SOURCE_CONTINUE;
        };
        // Run once immediately to reset stale state after restart
        sync();
        // Poll as a fallback in case signal wiring misses an edge
        this._screenShareWatchId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, sync);
        // Also listen to indicator visibility changes for instant updates
        this._connectScreenShareSignals();
    }

    _stopScreenShareWatcher() {
        if (this._screenShareWatchId) {
            GLib.Source.remove(this._screenShareWatchId);
            this._screenShareWatchId = 0;
        }
        // Disconnect any visibility listeners
        if (this._screenShareSignalIds?.length) {
            for (const [obj, id] of this._screenShareSignalIds) {
                try {
                    obj?.disconnect?.(id);
                } catch {
                }
            }
            this._screenShareSignalIds = [];
        }
    }

    _connectScreenShareSignals() {
        const sa = Main.panel?.statusArea ?? {};
        const candidates = [];
        // Known indicator entries on various GNOME versions
        for (const key of ['screenSharing', 'screencast', 'screenRecording']) {
            if (sa[key]) candidates.push(sa[key]);
        }
        // Quick Settings container can also expose them
        const qs = sa.quickSettings;
        if (qs) {
            for (const key of ['_screenSharing', 'screenSharing', '_screencast', 'screencast', '_screenRecording', 'screenRecording']) {
                if (qs[key]) candidates.push(qs[key]);
            }
            const indicators = qs._indicators ?? qs.indicators;
            if (indicators && typeof indicators.get_children === 'function') {
                for (const child of indicators.get_children()) candidates.push(child);
            }
        }

        const watch = (obj) => {
            const actor = obj?.actor || obj?.container || obj;
            if (!actor || typeof actor.connect !== 'function') return;
            const id = actor.connect('notify::visible', () => {
                // Recompute and sync immediately on visibility changes
                const active = this._isScreenSharingActive();
                this._setPrivateMode(active);
            });
            this._screenShareSignalIds.push([actor, id]);
        };

        for (const obj of candidates) watch(obj);
    }

    _fetchSettings() {
        this._maxRegistryLength = this._settings.get_int(PrefsFields.HISTORY_SIZE);
        this._maxEntryLength = this._settings.get_int(PrefsFields.PREVIEW_SIZE);
        this._cacheOnlyFavorite = this._settings.get_boolean(PrefsFields.CACHE_ONLY_FAVORITE);
        // Removed: DELETE_ENABLED (dead setting in this codebase)
        this._moveItemFirst = this._settings.get_boolean(PrefsFields.MOVE_ITEM_FIRST);
        this._notifyOnCopy = this._settings.get_boolean(PrefsFields.NOTIFY_ON_COPY);
        this._notifyOnCycle = this._settings.get_boolean(PrefsFields.NOTIFY_ON_CYCLE);
        this._enableKeybinding = this._settings.get_boolean(PrefsFields.ENABLE_KEYBINDING);
        this._maxTopbarLength = this._settings.get_int(PrefsFields.TOPBAR_PREVIEW_SIZE);
        this._clearOnBoot = this._settings.get_boolean(PrefsFields.CLEAR_ON_BOOT);
        this._disableDownArrow = this._settings.get_boolean(PrefsFields.DISABLE_DOWN_ARROW);
        this._stripText = this._settings.get_boolean(PrefsFields.STRIP_TEXT);
        this._cacheImages = this._settings.get_boolean(PrefsFields.CACHE_IMAGES);
        this._excludedApps = this._settings.get_strv(PrefsFields.EXCLUDED_APPS);
        this._pasteButtonSetting = this._settings.get_boolean(PrefsFields.PASTE_BUTTON);
        this._pinnedOnBottom = this._settings.get_boolean(PrefsFields.PINNED_ON_BOTTOM);
    }

    async _onSettingsChange() {
        try {
            // Load the settings into variables
            this._fetchSettings();

            // Remove old entries in case the registry size changed
            this._removeOldestEntries();

            // Re-set menu-items labels in case preview size changed
            this._getAllIMenuItems().forEach((mItem) => {
                this._setEntryLabel(mItem);
            });

            //update topbar
            this._updateTopbarLayout();
            this._updateIndicatorContent(await this._getClipboardContent());

            // Bind or unbind shortcuts
            if (this._enableKeybinding)
                this._bindShortcuts();
            else
                this._unbindShortcuts();
        } catch (e) {
            console.error('Clipboard Indicator: Failed to update registry');
            console.error(e);
        }
    }

    _bindShortcuts() {
        this._unbindShortcuts();
        this._bindShortcut(PrefsFields.BINDING_TOGGLE_MENU, this._toggleMenu);
    }

    _unbindShortcuts() {
        this._shortcutBindingIds.forEach(
            (id) => Main.wm.removeKeybinding(id)
        );

        this._shortcutBindingIds = [];
    }

    _bindShortcut(name, cb) {
        const ModeType = Shell.ActionMode;

        Main.wm.addKeybinding(
            name,
            this._settings,
            Meta.KeyBindingFlags.NONE,
            ModeType.ALL,
            cb.bind(this)
        );

        this._shortcutBindingIds.push(name);
    }

    _updateTopbarLayout() {
        this._icon.visible = true;
        this._buttonText.visible = false;
        this._buttonImgPreview.visible = false;
        this.show();

        this._downArrow.visible = !this._disableDownArrow;
    }

    _disconnectSettings() {
        if (!this._settingsChangedId)
            return;

        this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = 0;
    }

    _disconnectSelectionListener() {
        if (!this._selectionOwnerChangedId)
            return;

        this._selection.disconnect(this._selectionOwnerChangedId);
        this._selectionOwnerChangedId = 0;
        this._selection = null;
    }

    _clearDelayedSelectionTimeout() {
        if (this._delayedSelectionTimeoutId) {
            clearTimeout(this._delayedSelectionTimeoutId);
            this._delayedSelectionTimeoutId = null;
        }
    }

    _selectEntryWithDelay(entry) {
        this._selectMenuItem(entry, false);

        this._delayedSelectionTimeoutId = setTimeout(() => {
            this._selectMenuItem(entry);  //select the item
            this._delayedSelectionTimeoutId = null;
        }, this._delayedSelectionTimeout);
    }

    _previousEntry() {
        if (this._privateMode) return;

        this._clearDelayedSelectionTimeout();

        this._getAllIMenuItems().some((mItem, i, menuItems) => {
            if (mItem.currentlySelected) {
                i--;                                 //get the previous index
                if (i < 0) i = menuItems.length - 1; //cycle if out of bound
                let index = i + 1;                   //index to be displayed

                if (this._notifyOnCycle) {
                    this._showNotification(index + ' / ' + menuItems.length + ': ' + this._getEntryText(menuItems[i].entry));
                }
                if (this._moveItemFirst) {
                    this._selectEntryWithDelay(menuItems[i]);
                } else {
                    this._selectMenuItem(menuItems[i]);
                }
                return true;
            }
            return false;
        });
    }

    _nextEntry() {
        if (this._privateMode) return;

        this._clearDelayedSelectionTimeout();

        this._getAllIMenuItems().some((mItem, i, menuItems) => {
            if (mItem.currentlySelected) {
                i++;                                 //get the next index
                if (i === menuItems.length) i = 0;   //cycle if out of bound
                let index = i + 1;                     //index to be displayed

                if (this._notifyOnCycle) {
                    this._showNotification(index + ' / ' + menuItems.length + ': ' + this._getEntryText(menuItems[i].entry));
                }
                if (this._moveItemFirst) {
                    this._selectEntryWithDelay(menuItems[i]);
                } else {
                    this._selectMenuItem(menuItems[i]);
                }
                return true;
            }
            return false;
        });
    }

    _toggleMenu() {
        this.menu.toggle();
    }

    _pasteItem(menuItem) {
        this.menu.close();
        const currentlySelected = this._getCurrentlySelectedItem();
        this._preventIndicatorUpdate = true;
        this._updateClipboard(menuItem.entry);
        this._pastingKeypressTimeout = setTimeout(() => {
            if (this._keyboard.purpose === Clutter.InputContentPurpose.TERMINAL) {
                this._keyboard.press(Clutter.KEY_Control_L);
                this._keyboard.press(Clutter.KEY_Shift_L);
                this._keyboard.press(Clutter.KEY_Insert);
                this._keyboard.release(Clutter.KEY_Insert);
                this._keyboard.release(Clutter.KEY_Shift_L);
                this._keyboard.release(Clutter.KEY_Control_L);
            } else {
                this._keyboard.press(Clutter.KEY_Shift_L);
                this._keyboard.press(Clutter.KEY_Insert);
                this._keyboard.release(Clutter.KEY_Insert);
                this._keyboard.release(Clutter.KEY_Shift_L);
            }

            this._pastingResetTimeout = setTimeout(() => {
                this._preventIndicatorUpdate = false;
                if (currentlySelected) {
                    this._updateClipboard(currentlySelected.entry);
                }
            }, 50);
        }, 50);
    }

    _clearTimeouts() {
        if (this._imagePreviewTimeout) {
            clearTimeout(this._imagePreviewTimeout);
            this._imagePreviewTimeout = null;
        }
        if (this._setFocusOnOpenTimeout) {
            clearTimeout(this._setFocusOnOpenTimeout);
            this._setFocusOnOpenTimeout = null;
        }
        if (this._pastingKeypressTimeout) {
            clearTimeout(this._pastingKeypressTimeout);
            this._pastingKeypressTimeout = null;
        }
        if (this._pastingResetTimeout) {
            clearTimeout(this._pastingResetTimeout);
            this._pastingResetTimeout = null;
        }
    }

    _clearClipboard() {
        this._clipboard.set_text(CLIPBOARD_TYPE, '');
        this._updateIndicatorContent(null);
    }

    _updateClipboard(entry) {
        this._clipboard.set_content(CLIPBOARD_TYPE, entry.mimetype(), entry.asBytes());
        this._updateIndicatorContent(entry);
    }

    async _getClipboardContent() {
        const mimetypes = [
            "text/plain;charset=utf-8",
            "UTF8_STRING",
            "text/plain",
            "STRING",
            'image/gif',
            'image/png',
            'image/jpg',
            'image/jpeg',
            'image/webp',
            'image/svg+xml',
            'text/html',
        ];

        for (let type of mimetypes) {
            const result = await new Promise(resolve => this._clipboard.get_content(CLIPBOARD_TYPE, type, (clipBoard, bytes) => {
                if (bytes === null || bytes.get_size() === 0) {
                    resolve(null);
                    return;
                }

                // HACK: workaround for GNOME 2nd+ copy mangling mimetypes https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/8233
                // In theory GNOME or XWayland should auto-convert this back to UTF8_STRING for legacy apps when it's needed https://gitlab.gnome.org/GNOME/gtk/-/merge_requests/5300
                if (type === "UTF8_STRING") {
                    type = "text/plain;charset=utf-8";
                }

                const entry = new ClipboardEntry(type, bytes.get_data(), false);
                if (this._cacheImages && entry.isImage()) {
                    this._registry.writeEntryFile(entry);
                }
                resolve(entry);
            }));

            if (result) {
                if (!this._cacheImages && result.isImage()) {
                    return null;
                } else {
                    return result;
                }
            }
        }

        return null;
    }
});
