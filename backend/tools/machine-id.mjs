// 稳定机器指纹：把加密后的后端源码绑定到「授权机器」。
// 离开本机 → 指纹不符 → 解密失败 → 程序拒绝启动（防内网拷贝后异地复用）。
// 指纹来源按平台取最稳定且重装不易变的标识；全部失败才回落到主机名+MAC。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

export function machineId() {
  try {
    if (process.platform === 'win32') {
      // Windows：注册表 MachineGuid（系统级、相对硬件稳定）
      const out = execFileSync(
        'reg',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf8' }
      );
      const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36,})/);
      if (m) return 'win:' + m[1].trim().toLowerCase();
    } else if (process.platform === 'linux') {
      if (fs.existsSync('/etc/machine-id')) return 'lin:' + fs.readFileSync('/etc/machine-id', 'utf8').trim();
      if (fs.existsSync('/var/lib/dbus/machine-id')) return 'lin:' + fs.readFileSync('/var/lib/dbus/machine-id', 'utf8').trim();
    } else if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) return 'mac:' + m[1].trim().toLowerCase();
    }
  } catch { /* 落到兜底 */ }

  // 兜底：主机名 + 首块非内环网卡的 MAC（弱，但至少不是常量）
  let mac = '';
  try {
    const ifaces = os.networkInterfaces();
    outer: for (const list of Object.values(ifaces)) {
      for (const i of list || []) {
        if (!i.internal && i.mac && i.mac !== '00:00:00:00:00:00') { mac = i.mac.toLowerCase(); break outer; }
      }
    }
  } catch { /* ignore */ }
  return 'fallback:' + (mac || os.hostname()).toLowerCase();
}
