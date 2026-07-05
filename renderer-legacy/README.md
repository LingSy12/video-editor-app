# 旧版 UI 备份 (v1.17.2)

v1.18.0 换用新版停靠式深色界面前的完整备份(index.html / styles.css / renderer.js 三件套)。

## 回滚方法

把本目录的三个文件复制回 `renderer/` 覆盖即可(`renderer/ui-shell.js` 可留可删,旧版 index.html 不会加载它):

```powershell
Copy-Item renderer-legacy\index.html,renderer-legacy\styles.css,renderer-legacy\renderer.js renderer\ -Force
```
