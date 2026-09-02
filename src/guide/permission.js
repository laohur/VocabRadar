// 麦克风权限预热（2026-08-18 第七十三次修正）：原 inline script 被 manifest CSP
//   extension_pages "script-src 'self'" 禁止（inline 永不执行），从未真正请求权限。
//   改为外部脚本文件，CSP 允许 'self' 脚本。请求成功立即释放轨道。
// 反思（2026-08-19 第八十次）：由"预热"改为"按需授权"——不再在 init 时静默调用，
//   改为录制按钮点击时注入本 iframe（用户手势内）。结果经 postMessage 回报父页
//   （asr.js 曾用 requestMicPermission 接收；v81 起已废弃该方案，改为主文档直接
//   getUserMedia，本文件保留作历史说明），授权成功才继续 startRecord。
navigator.mediaDevices.getUserMedia({ audio: true })
  .then(s => { s.getTracks().forEach(t => t.stop()); window.parent.postMessage({ __beaverPerm: 'granted' }, '*'); })
  .catch(() => { window.parent.postMessage({ __beaverPerm: 'denied' }, '*'); });
