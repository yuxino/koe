Koe 快速安装
============

支持 Apple Silicon Mac、macOS 15 或更高版本；Intel Mac 暂不支持。
请先安装 ego-lite：https://www.egolite.ai/download

1. 双击“Install Koe.command”。
2. 安装完成后，在打开的 ego-lite 扩展页开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本目录中的“Koe Extension”。
4. 打开视频，点 Koe，再点“开启本地精准字幕”。

请把本目录放在长期保留的位置。ego-lite 会直接从“Koe Extension”读取扩展；加载后移动或删除本目录，会导致 Koe 不可用。

无需 Xcode、Swift、管理员权限或手动填写扩展 ID。下载约 2 MB，解压约 6 MB；安装器会按系统从两套 Helper 中只安装一套，另写入约 3 MB。macOS 15–25 可本地识别原文；macOS 26+ 安装 Apple 语言包后可本机翻译。

安装包不包含 Whisper 模型；首次开启本地字幕时会另外下载约 626 MB，之后复用本机缓存。

当前 Git 下载包属于开发预览，Helper 尚未使用 Developer ID 签名和 Apple 公证。安装器校验复制的 Helper 后会只处理该文件的下载隔离标记；如果 macOS 阻止安装器自身，请按住 Control 点击“Install Koe.command”，选择“打开”，并确认一次。

升级 1.9.0 之后的版本时，请把新“Koe Extension”中的文件覆盖到浏览器当前加载的原目录，再运行安装器并点“重新加载”。只解压到新目录并重新加载旧扩展不会更新代码。从 1.8.3 或更早版本升级需要先移除旧 Koe，重新加载，并重新填写旧扩展保存的 DashScope API Key。

安装器也写入 Google Chrome 的兼容注册，但当前只自动打开并验证 ego-lite；Chrome 需要手动加载扩展。


Koe Quick Install
=================

Requires an Apple silicon Mac running macOS 15 or later. Intel Macs are unsupported.
Install ego-lite first: https://www.egolite.ai/download

1. Double-click “Install Koe.command”.
2. When installation finishes, enable Developer mode on the ego-lite extensions page.
3. Choose Load unpacked and select “Koe Extension” from this folder.
4. Open a video, choose Koe, then click “开启本地精准字幕”.

Keep this folder in a permanent location. ego-lite reads the extension directly from “Koe Extension”; moving or deleting this folder after loading will make Koe unavailable.

No Xcode, Swift toolchain, administrator access, or extension ID is required. The download is about 2 MB and expands to about 6 MB; the installer chooses one of two Helpers and writes about 3 MB. macOS 15–25 transcribes locally in the original language. macOS 26+ can translate locally after its Apple language pack is installed.

The Whisper model is not bundled; the first local-caption session downloads about 626 MB and reuses the local cache afterward.

This Git download is a developer preview. The Helper is not yet Developer ID signed or Apple notarized. The installer validates the copied Helper before clearing quarantine only from that file. If macOS blocks the installer itself, Control-click “Install Koe.command”, choose Open, and confirm once.

For upgrades after 1.9.0, replace the files in the same “Koe Extension” folder currently loaded by the browser, rerun the installer, and click Reload. Extracting elsewhere and reloading the old entry does not update its code. Upgrading from 1.8.3 or earlier requires removing the old Koe entry, loading the new one, and re-entering any DashScope API Key stored by the old extension.

The installer also writes a Google Chrome compatibility registration, but currently opens and tests only ego-lite. Chrome must be loaded manually.
