import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Render an inspectable LaunchAgent; installation stays an explicit OS operation. */
export function launchd(source: string, db: string, policy: string) {
  const values = [
    process.execPath,
    fileURLToPath(new URL("cli.js", import.meta.url)),
    "watch",
    "--source",
    source,
    "--db",
    db,
    "--policy",
    policy,
  ];
  for (const path of [source, db, policy]) {
    if (!isAbsolute(path))
      throw new Error("LaunchAgent paths must be absolute");
  }
  const xml = (value: string) => {
    if (
      !value.isWellFormed() ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value)
    )
      throw new Error("Path contains characters unsupported by XML");
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>local.coding-session-history.writer</string>
<key>ProgramArguments</key><array>${values.map((value) => `<string>${xml(value)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>ProcessType</key><string>Background</string>
<key>Umask</key><integer>63</integer>
<key>StandardErrorPath</key><string>${xml(join(dirname(db), "writer.log"))}</string>
</dict></plist>`;
}
