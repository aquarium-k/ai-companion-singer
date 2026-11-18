/**
 * 推送辅助脚本（这台机器的网络环境专用）。
 *
 * 背景：本机到 `github.com` 的 **DNS 被污染**（解析出 20.6.7.17 / 192.5.6.30 这类
 * 根 DNS 服务器地址），而 GitHub 的真实 IP 又很慢（实测 0.1 KB/s）。所以：
 *
 *   - `origin` 指向 `ssh://git@ssh.github.com:443/...`（GitHub 的 SSH-over-443 入口，
 *     域名解析正常、连接只要 1–2 秒）；
 *   - SSH 密钥放在 `.tmp/ssh/id_ed25519`（已被 .gitignore 忽略，不会进仓库），
 *     用 Windows 自带的 OpenSSH 客户端；
 *   - 这些都写在本脚本里，省得每次记。
 *
 * 用法：
 *   node scripts/push.mjs                # = git push
 *   node scripts/push.mjs --tags         # 透传参数
 *   node scripts/push.mjs -u origin main
 *
 * 换机器/换密钥时改这里，或者直接 `git remote set-url origin <https 地址>` 配合代理。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const git = [
  join(root, '.tmp', 'tools', 'git', 'cmd', 'git.exe'),
  'git',
].find((p) => p === 'git' || existsSync(p))
const ssh = [
  'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
  join(root, '.tmp', 'tools', 'git', 'usr', 'bin', 'ssh.exe'),
].find((p) => existsSync(p))
const key = join(root, '.tmp', 'ssh', 'id_ed25519')

if (!existsSync(key)) {
  console.error(`[push] 找不到私钥：${key}`)
  console.error('[push] 重新生成并用 `gh ssh-key add` 注册，或改回 https + 本地代理（见 docs/release.md 九）')
  process.exit(1)
}

const env = { ...process.env }
if (ssh) {
  // UserKnownHostsFile=NUL：这台机器写不了 ~/.ssh（沙箱），不落 known_hosts
  env.GIT_SSH_COMMAND =
    `"${ssh}" -i "${key}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o BatchMode=yes`
}

const child = spawn(git, ['push', ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 1))
