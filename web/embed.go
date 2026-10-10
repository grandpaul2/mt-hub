// Package web holds the built frontend. Run `make` (or `npm run build`) before `go build`:
// dist/ is generated and not tracked.
package web

import "embed"

//go:embed dist
var Dist embed.FS
