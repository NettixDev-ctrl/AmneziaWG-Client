package main

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// ParsedConf — результат очистки конфигурации перед передачей awg-quick (Linux).
type ParsedConf struct {
	Text         string // очищенный текст
	EndpointHost string
	EndpointPort int
	Peers        int
	DNS          []string
}

var scriptKeys = map[string]bool{"preup": true, "postup": true, "predown": true, "postdown": true}

// DNS удаляется: awg-quick вызывает resolvconf, а тот отказывается трогать /etc/resolv.conf,
// если его правил systemd-resolved или NetworkManager. DNS туннеля задаётся через resolvectl (см. manager).
var droppedKeys = map[string]bool{"saveconfig": true, "table": true, "fwmark": true, "dns": true}

// SanitizeConf проверяет конфигурацию так, чтобы awg-quick (shell-скрипт, работающий от root) не мог
// выполнить ничего постороннего: скрипты отклоняются, управляющие параметры маршрутизации удаляются.
// Значения параметров AWG не интерпретируются — их проверяет сам awg.
func SanitizeConf(text string) (*ParsedConf, error) {
	if strings.ContainsRune(text, 0) {
		return nil, errors.New("конфигурация содержит недопустимые символы")
	}
	var out []string
	section := ""
	ifaces, peers := 0, 0
	pc := &ParsedConf{}
	for i, raw := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(strings.TrimPrefix(raw, "\ufeff"))
		if cut := strings.Index(line, "#"); cut >= 0 {
			line = strings.TrimSpace(line[:cut])
		}
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "[") {
			name := strings.ToLower(strings.TrimSpace(strings.Trim(line, "[]")))
			switch name {
			case "interface":
				ifaces++
			case "peer":
				peers++
			default:
				return nil, fmt.Errorf("строка %d: неизвестный раздел", i+1)
			}
			section = name
			out = append(out, "["+strings.ToUpper(name[:1])+name[1:]+"]")
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok || section == "" {
			return nil, fmt.Errorf("строка %d: ожидается «параметр = значение» внутри раздела", i+1)
		}
		key := strings.ToLower(strings.TrimSpace(k))
		val := strings.TrimSpace(v)
		if scriptKeys[key] {
			return nil, errors.New("скрипты в конфигурации не поддерживаются")
		}
		if key == "dns" {
			for _, d := range strings.Split(val, ",") {
				if d = strings.TrimSpace(d); d != "" {
					pc.DNS = append(pc.DNS, d)
				}
			}
		}
		if droppedKeys[key] {
			continue
		}
		if strings.ContainsAny(key, " \t") {
			return nil, fmt.Errorf("строка %d: недопустимое имя параметра", i+1)
		}
		if section == "peer" && key == "endpoint" {
			host, port, err := splitEndpoint(val)
			if err != nil {
				return nil, err
			}
			pc.EndpointHost, pc.EndpointPort = host, port
		}
		out = append(out, strings.TrimSpace(k)+" = "+val)
	}
	if ifaces != 1 {
		return nil, errors.New("нужен ровно один раздел [Interface]")
	}
	if peers != 1 {
		return nil, errors.New("поддерживается ровно один сервер ([Peer])")
	}
	if pc.EndpointHost == "" {
		return nil, errors.New("в [Peer] не указан Endpoint")
	}
	pc.Peers = peers
	pc.Text = strings.Join(out, "\n") + "\n"
	return pc, nil
}

func splitEndpoint(v string) (string, int, error) {
	var host, port string
	if strings.HasPrefix(v, "[") {
		end := strings.Index(v, "]:")
		if end < 0 {
			return "", 0, errors.New("некорректный Endpoint")
		}
		host, port = v[1:end], v[end+2:]
	} else {
		i := strings.LastIndex(v, ":")
		if i < 0 {
			return "", 0, errors.New("некорректный Endpoint")
		}
		host, port = v[:i], v[i+1:]
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 || host == "" || strings.ContainsAny(host, " \t/\\;|&$`'\"") {
		return "", 0, errors.New("некорректный Endpoint")
	}
	return host, p, nil
}
