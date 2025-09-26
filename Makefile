INSTALLPATH=~/.local/share/gnome-shell/extensions/clipboard@journeycorner.com/

DIST_DIR := dist
STATIC_FILES := metadata.json stylesheet.css LICENSE.rst README.rst
SCHEMA_DIR := schemas
SCHEMA_XML := $(wildcard $(SCHEMA_DIR)/*.xml)
TS_SOURCES := $(shell find src -name '*.ts' ! -name '*.d.ts')
TS_BUILD_STAMP := .ts-build-stamp

all: compile-ts prepare-dist compile-locales compile-settings

compile-ts: $(TS_BUILD_STAMP)

$(TS_BUILD_STAMP): $(TS_SOURCES) tsconfig.json package.json package-lock.json
	npm run build
	mkdir -p $(dir $@)
	touch $@

prepare-dist: $(STATIC_FILES) $(SCHEMA_XML)
	mkdir -p $(DIST_DIR)
	cp $(STATIC_FILES) $(DIST_DIR)/
	rm -rf $(DIST_DIR)/$(SCHEMA_DIR)
	mkdir -p $(DIST_DIR)/$(SCHEMA_DIR)
	cp $(SCHEMA_DIR)/*.xml $(DIST_DIR)/$(SCHEMA_DIR)/

compile-settings: prepare-dist
	glib-compile-schemas --strict --targetdir=$(DIST_DIR)/$(SCHEMA_DIR) $(DIST_DIR)/$(SCHEMA_DIR)

compile-locales:
	@true

update-po-files:
	@true

install: all
	rm -rf $(INSTALLPATH)
	mkdir -p $(INSTALLPATH)
	cp -r $(DIST_DIR)/* $(INSTALLPATH)/

nested-session:
	dbus-run-session -- gnome-shell --devkit

bundle: all
	rm -f bundle.zip
	cd $(DIST_DIR) && zip -FSr ../bundle.zip .
