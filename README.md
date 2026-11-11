# folia-lyrics for GNOME Shell

这是 `folia-lyrics` GNOME Shell 扩展。它使用兼容的逐字歌词模型和 MPRIS 播放逻辑，宿主层为 GNOME Shell 的 `PanelMenu.Button`、`St`、Gio D-Bus 与 GSettings。

## 功能

- 从可直接访问的 Folia v1 接口读取逐字歌词快照；
- 从 `org.mpris.MediaPlayer2.*` 获取播放状态、进度、媒体信息与播放控制能力；
- 支持全局毫秒 `offset`、原文/翻译优先、行间空隙和最后一句保留；
- 只有匹配 `player-match` 的播放器会推动歌词时间轴，其它播放器显示自己的 MPRIS 标题；
- 当前词高亮、已唱/未唱透明度、播放暂停时保留滚动位置并显示删除线；
- 长歌词自动滚动；
- 悬浮详情：封面、标题、艺术家、专辑、进度、原文、翻译和上一首/播放暂停/下一首；
- 设置界面中可修改 API、轮询间隔、面板分区、宽度和播放器匹配等选项。

## 兼容性

- GNOME Shell 45–51；
- 已在 GNOME Shell 51.1 / GJS 1.90 上通过代码、schema 和打包检查；
- 使用 Soup 3 与 Gio D-Bus，不依赖 Quickshell、Omarchy 或第三方 MPRIS 扩展。

## 安装

在项目根目录执行：

```bash
cd gnome-extension
make pack
gnome-extensions install --force dist/folia-lyrics@Yohane-Mashiro.shell-extension.zip
```

Wayland 会话需要注销并重新登录，让 GNOME Shell 重新加载扩展；Xorg 会话可尝试 `Alt+F2`，输入 `r` 后回车。

启用：

```bash
gnome-extensions enable folia-lyrics@Yohane-Mashiro
gnome-extensions prefs folia-lyrics@Yohane-Mashiro
```

也可以直接打包链接到系统扩展目录，便于迭代：

```bash
mkdir -p ~/.local/share/gnome-shell/extensions
ln -sfn "$PWD" ~/.local/share/gnome-shell/extensions/folia-lyrics@Yohane-Mashiro
glib-compile-schemas "$PWD/schemas"
```

修改代码后，在 Wayland 下仍需注销重新登录；修改 `stylesheet.css`、设置 schema 或重新安装扩展后尤其如此。

## 使用

1. 在 Folia 中打开：设置 → 连接与集成 → 歌词接口 → 启用歌词接口；
2. 确认默认接口 `http://127.0.0.1:32109/v1/lyric` 可访问；
3. 播放音乐，默认 `player-match=folia` 会等待 Folia 的 MPRIS 会话；
4. 鼠标悬浮歌词打开详情；左键切换播放/暂停，右键或中键立即刷新歌词。

如果歌词接口属于另一个播放器，请在设置中修改“Lyric player match”。匹配值会依次检查 MPRIS 的 identity、desktop entry 和总线名，不区分大小写。留空表示接受任意播放器。

## 调试

查看 GNOME Shell 日志：

```bash
journalctl --user -f -o cat /usr/bin/gnome-shell
```

扩展 UUID 为 `folia-lyrics@Yohane-Mashiro`。若设置无法打开，确认 `schemas/gschemas.compiled` 已生成；`make pack` 会把 schema 放入扩展包，由安装器处理。
