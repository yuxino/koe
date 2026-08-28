Koe 快速安装
============

支持 Apple Silicon Mac、macOS 15 或更高版本；Intel Mac 暂不支持。
请先安装 ego-lite：https://www.egolite.ai/download

1. 双击“Install Koe.command”。
2. 安装器会把扩展复制到固定位置并打开 ego-lite，Koe 会自动出现。
3. 打开视频，点 Koe，再点“开启本地精准字幕”。

安装后可以移动或删除本目录。Koe 会在每次重新打开 ego-lite 后自动恢复，无需再次导入。自动恢复只在正版 ego-lite 的本地套接字存在时运行，核对浏览器发布者以及 Koe 的固定 ID、版本、安装路径和文件哈希；它不读取网页内容、浏览历史、Cookie 或 Koe 设置。恢复过程只使用一个不含用户页面的隔离空任务，并在校验完成后立即关闭。若要停用，请运行“~/Library/Application Support/Koe/Disable Koe Auto-Load.command”；当前会话会保留 Koe，下次重开不再恢复。重新运行安装器即可恢复。

无需 Xcode、Swift、管理员权限或手动填写扩展 ID。下载约 1.5–2 MB，解压约 4 MB；本次版本安装约 3 MB，旧版 Helper 可能保留用于排障。macOS 15–25 可本地识别原文；macOS 26+ 安装 Apple 语言包后可本机翻译。

安装包不包含 Whisper 模型；首次开启本地字幕时会另外下载约 626 MB，之后复用本机缓存。

当前 Git 下载包属于开发预览，Helper 尚未使用 Developer ID 签名和 Apple 公证。安装器校验复制的 Helper 后会只处理该文件的下载隔离标记；如果 macOS 阻止安装器自身，请按住 Control 点击“Install Koe.command”，选择“打开”，并确认一次。

若此前手动加载过 1.9.0–1.9.4，运行新版安装器后正常退出并重新打开 ego-lite 一次；若扩展页仍显示旧目录，请先移除旧 Koe，再重新运行安装器。之后升级只需重新运行安装器。从 1.8.3 或更早版本升级需要先移除旧 Koe，并重新填写旧扩展保存的 DashScope API Key。

安装器也写入 Google Chrome 的兼容注册，但自动恢复只针对 ego-lite；Chrome 需要手动加载“~/Library/Application Support/Koe/Extension”。


Koe Quick Install
=================

Requires an Apple silicon Mac running macOS 15 or later. Intel Macs are unsupported.
Install ego-lite first: https://www.egolite.ai/download

1. Double-click “Install Koe.command”.
2. The installer copies the extension to a stable location and opens ego-lite; Koe appears automatically.
3. Open a video, choose Koe, then click “开启本地精准字幕”.

You can move or delete this folder after installation. Koe restores itself whenever ego-lite reopens, with no repeated import. The loader runs only while a genuine ego-lite local socket exists and verifies the browser publisher plus Koe's fixed ID, version, managed path, and file hashes; it does not read page content, browsing history, cookies, or Koe settings. Restoration uses one isolated empty task with no user pages and closes it immediately after verification. Run “~/Library/Application Support/Koe/Disable Koe Auto-Load.command” to disable restore. Koe remains for the current browser process, but the next launch will not restore it. Rerun the installer to enable restore again.

No Xcode, Swift toolchain, administrator access, or extension ID is required. The download is about 1.5–2 MB and expands to about 4 MB; the current version installs about 3 MB, while an older Helper may remain for diagnostics. macOS 15–25 transcribes locally in the original language. macOS 26+ can translate locally after its Apple language pack is installed.

The Whisper model is not bundled; the first local-caption session downloads about 626 MB and reuses the local cache afterward.

This Git download is a developer preview. The Helper is not yet Developer ID signed or Apple notarized. The installer validates the copied Helper before clearing quarantine only from that file. If macOS blocks the installer itself, Control-click “Install Koe.command”, choose Open, and confirm once.

If 1.9.0–1.9.4 was loaded manually, run the new installer and quit/reopen ego-lite once. If the extensions page still shows the old folder, remove that old Koe entry and rerun the installer. Later upgrades only require rerunning the installer. Upgrading from 1.8.3 or earlier requires removing the old Koe entry and re-entering any DashScope API Key stored by the old extension.

The installer also writes a Google Chrome compatibility registration, but automatic restore is limited to ego-lite. Chrome must load “~/Library/Application Support/Koe/Extension” manually.
