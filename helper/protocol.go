package main

import (
	"errors"
	"fmt"

	"github.com/privata/awg-client/helper/split"
)

// Протокол обмена с приложением: одна строка JSON на запрос и одна на ответ через именованный
// канал \\.\pipe\PrivataVPN. Все поля проверяются в Validate; произвольные команды и пути
// принимать нельзя: путь к конфигурации и имя службы задаёт только сама служба.

const (
	OpHello      = "hello"
	OpStatus     = "status"
	OpConnect    = "connect"
	OpDisconnect = "disconnect"
	OpRecover    = "recover"
	OpLogs       = "logs"
	OpShutdown   = "shutdown" // Linux: служба по требованию завершает работу

	MaxRequestBytes = 128 * 1024
	MaxConfigBytes  = 64 * 1024
	MaxApps         = 200
)

type SplitRequest struct {
	Mode string   `json:"mode"`
	Apps []string `json:"apps"`
}

// Options — параметры, которые на Linux применяет сама служба (на Windows они закодированы в маршрутах конфигурации).
type Options struct {
	KillSwitch bool `json:"killSwitch"`
	AllowLAN   bool `json:"allowLan"`
}

type Request struct {
	Op            string        `json:"op"`
	Options       *Options      `json:"options,omitempty"`
	Config        string        `json:"config,omitempty"`
	Split         *SplitRequest `json:"split,omitempty"`
	StaleAfterSec int           `json:"staleAfterSec,omitempty"`
	Tail          int           `json:"tail,omitempty"`
}

type SplitStatus struct {
	State       string  `json:"state"` // off | starting | running | failed
	Error       *string `json:"error"`
	ActiveFlows int     `json:"activeFlows"`
}

// Status зеркалит HelperStatus из src/shared/tunnelState.ts.
type Status struct {
	State           string      `json:"state"` // stopped | starting | running | stopping | failed
	HandshakeAgeSec *float64    `json:"handshakeAgeSec"`
	RxBytes         uint64      `json:"rxBytes"`
	TxBytes         uint64      `json:"txBytes"`
	ErrorCode       *string     `json:"errorCode"`
	Error           *string     `json:"error"`
	Split           SplitStatus `json:"split"`
}

type ErrorInfo struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Response struct {
	OK      bool       `json:"ok"`
	Error   *ErrorInfo `json:"error,omitempty"`
	Status  *Status    `json:"status,omitempty"`
	Version string     `json:"version,omitempty"`
	Logs    []string   `json:"logs,omitempty"`
}

func errResp(code, msg string) Response {
	return Response{OK: false, Error: &ErrorInfo{Code: code, Message: msg}}
}

// ValidatedConnect — проверенные и нормализованные параметры подключения.
type ValidatedConnect struct {
	Config        string
	SplitMode     split.Mode
	SplitApps     []string
	StaleAfterSec int
	Options       Options
}

func Validate(r *Request) (*ValidatedConnect, error) {
	switch r.Op {
	case OpHello, OpStatus, OpDisconnect, OpRecover, OpShutdown:
		return nil, nil
	case OpLogs:
		if r.Tail < 0 || r.Tail > 2000 {
			return nil, errors.New("недопустимое число строк журнала")
		}
		return nil, nil
	case OpConnect:
	default:
		return nil, fmt.Errorf("неизвестная операция %q", r.Op)
	}
	if r.Config == "" || len(r.Config) > MaxConfigBytes {
		return nil, errors.New("конфигурация пуста или слишком велика")
	}
	v := &ValidatedConnect{Config: r.Config, SplitMode: split.ModeAll, StaleAfterSec: 195}
	if r.Options != nil {
		v.Options = *r.Options
	}
	if r.StaleAfterSec != 0 {
		if r.StaleAfterSec < 30 || r.StaleAfterSec > 900 {
			return nil, errors.New("недопустимый порог устаревания рукопожатия")
		}
		v.StaleAfterSec = r.StaleAfterSec
	}
	if r.Split != nil {
		m := split.Mode(r.Split.Mode)
		if !m.Valid() {
			return nil, errors.New("недопустимый режим раздельного туннелирования")
		}
		v.SplitMode = m
		if m != split.ModeAll {
			if len(r.Split.Apps) > MaxApps {
				return nil, errors.New("слишком много приложений в правилах")
			}
			seen := map[string]bool{}
			for _, a := range r.Split.Apps {
				n, err := split.NormalizePath(a)
				if err != nil {
					return nil, fmt.Errorf("недопустимый путь приложения: %w", err)
				}
				if !seen[n] {
					seen[n] = true
					v.SplitApps = append(v.SplitApps, a)
				}
			}
			if m == split.ModeInclude && len(v.SplitApps) == 0 {
				// «Только выбранные через VPN» без выбранных приложений означало бы «ничего не через VPN».
				return nil, errors.New("для режима «только выбранные приложения» добавьте хотя бы одно приложение")
			}
			if m == split.ModeBypass && len(v.SplitApps) == 0 {
				v.SplitMode = split.ModeAll
			}
		}
	}
	return v, nil
}
