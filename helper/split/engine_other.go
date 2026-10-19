//go:build !windows

package split

import "errors"

// ErrUnsupported возвращается на платформах, отличных от Windows.
var ErrUnsupportedPlatform = errors.New("раздельное туннелирование поддерживается только в Windows")
