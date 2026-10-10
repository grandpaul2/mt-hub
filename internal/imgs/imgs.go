// Package imgs makes the small copies of pictures that grids and previews show.
package imgs

import (
	"bytes"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"strings"

	"golang.org/x/image/draw"
)

// ThumbW is the thumbnail width. Pages show thumbnails up to this size and the original
// above it.
const ThumbW = 640

// WriteThumb saves a copy of img at most ThumbW wide: PNG if path ends in .png (keeps
// transparency; the schematics board's renders need it), JPEG otherwise.
func WriteThumb(path string, img image.Image) error {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w > ThumbW {
		w, h = ThumbW, max(1, h*ThumbW/w)
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Src, nil)
	var buf bytes.Buffer
	var err error
	if strings.HasSuffix(path, ".png") {
		err = png.Encode(&buf, dst)
	} else {
		err = jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 82})
	}
	if err != nil {
		return err
	}
	return os.WriteFile(path, buf.Bytes(), 0o644)
}
