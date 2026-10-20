# `make` builds bin/mthub with the frontend embedded. `make check` runs tests and the type check
# (test/unit/: the voice microphone chain against the game's, in Node).
# `make browser-test` drives the page in headless Chromium (test/browser/; needs chromium).
# `make firefox-check` compares a real Firefox window's screen pixels with what Firefox meant to
# draw (test/firefox/; opens a window for about a minute, so run it by hand).
.PHONY: all web check browser-test firefox-check clean

all: web
	go build -o bin/mthub ./cmd/mthub

web: node_modules
	node build.mjs

node_modules: package.json package-lock.json
	npm ci
	touch node_modules

# The Go code embeds web/dist, so vet and test need the page built first.
check: web
	npx tsc
	node --test test/unit/
	go vet ./...
	go test ./...

browser-test: node_modules
	node test/browser/run.mjs

firefox-check: all
	node test/firefox/check.mjs

clean:
	rm -rf bin web/dist
