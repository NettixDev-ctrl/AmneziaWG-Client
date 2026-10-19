# Сторонние компоненты

Оригинальный код проекта распространяется по лицензии MIT (см. `LICENSE`). Перечисленные ниже
компоненты сохраняют собственные лицензии.

| Компонент | Версия | Лицензия | Как используется |
|---|---|---|---|
| [amneziawg-go](https://github.com/amnezia-vpn/amneziawg-go) | v3.1.20260814 | MIT (WireGuard LLC) | Реализация протокола AmneziaWG 3.x, статически вкомпонована в `awg-helper.exe` |
| [amneziawg-windows](https://github.com/amnezia-vpn/amneziawg-windows) | v3.1.20260814 | MIT (WireGuard LLC) | Служба туннеля Windows: адаптер, маршруты, DNS, брандмауэр, разбор конфигурации AWG |
| [go-winio](https://github.com/microsoft/go-winio) | v0.6.4 | MIT (Microsoft) | Именованные каналы Windows |
| golang.org/x/{sys,crypto,net,text,time}, golang.zx2c4.com/wintun (Go-привязка) | см. `helper/go.mod` | BSD-3-Clause / MIT | Зависимости Go |
| [Wintun](https://www.wintun.net/) `wintun.dll` 0.14.1 | 0.14.1 | «Prebuilt Binaries License» WireGuard LLC (`LICENSE-wintun.txt`) | Драйвер виртуального адаптера. Распространяется без изменений рядом с программой, использующей его только через разрешённый API (`wintun.h`). Файл не изменять |
| [WinDivert](https://reqrypt.org/windivert.html) 2.2.2-A | 2.2.2 | LGPL-3.0 или GPL-2.0 на выбор (`LICENSE-WinDivert.txt`) | Перехват пакетов для раздельного туннелирования. Неизменённые `WinDivert.dll` и `WinDivert64.sys` подгружаются динамически; исходный код: https://github.com/basil00/WinDivert |
| [Electron](https://www.electronjs.org/) | 44.x | MIT | Оболочка приложения |
| [React](https://react.dev/) | 19.x | MIT | Интерфейс |
| [i18n-iso-countries](https://github.com/michaelwittig/node-i18n-iso-countries) | 7.x | MIT | Коды и названия стран |
| [flag-icons](https://github.com/lipis/flag-icons) | 7.x | MIT | SVG-флаги, вшитые в приложение |
| [Natural Earth](https://www.naturalearthdata.com/) через `world-atlas` | — | Общественное достояние | Данные для точечного глобуса (генерируются `scripts/gen-globe-data.mjs`) |

Контрольные суммы SHA-256 загружаемых бинарных файлов зафиксированы в `scripts/fetch-native.mjs`.
