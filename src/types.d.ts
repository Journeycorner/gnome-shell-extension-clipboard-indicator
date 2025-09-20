import '@girs/glib-2.0/ambient';
import '@girs/gobject-2.0/ambient';
import '@girs/gio-2.0/ambient';
import '@girs/clutter-12/ambient';
import '@girs/meta-13/ambient';
import '@girs/shell-13/ambient';
import '@girs/st-13/ambient';
import '@girs/adw-1/ambient';
import '@girs/gtk-4.0/ambient';
import '@girs/gdk-4.0/ambient';
import '@girs/gnome-shell/ambient';

// Some modules under resource:/// still lack type coverage; fall back to unknown
declare module 'resource://*' {
  const resourceModule: unknown;
  export = resourceModule;
}

declare const global: any;
