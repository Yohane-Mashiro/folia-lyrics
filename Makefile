UUID := folia-lyrics@Yohane-Mashiro
SCHEMA := org.gnome.shell.extensions.yohane-mashiro.gschema.xml
DIST := dist

.PHONY: check pack clean

check:
	node --check extension.js
	node --check mpris.js
	node --experimental-default-type=module --test tests/lyric-model.test.mjs
	glib-compile-schemas --strict --dry-run schemas

pack: check
	mkdir -p $(DIST)
	gnome-extensions pack . --force --out-dir=$(DIST) \
		--schema=schemas/$(SCHEMA) \
		--extra-source=lyricModel.js \
		--extra-source=mpris.js

clean:
	rm -rf $(DIST)
