import type { ContainerDTO } from "@/types/api";

export function containerToLabelsYaml(ctr: ContainerDTO): string {
  const lines: string[] = [];
  lines.push(`# firefik config for ${ctr.name} (${ctr.id.slice(0, 12)})`);
  lines.push("labels:");
  lines.push(`  firefik.enable: "${ctr.enabled ? "true" : "false"}"`);
  if (ctr.defaultPolicy) {
    lines.push(`  firefik.defaultpolicy: "${ctr.defaultPolicy}"`);
  }
  for (const rs of ctr.ruleSets ?? []) {
    if (rs.name.startsWith("tpl:") || rs.name.startsWith("pol:")) {
      continue;
    }
    const prefix = `firefik.firewall.${rs.name}`;
    if (rs.ports?.length) {
      lines.push(`  ${prefix}.ports: "${rs.ports.join(",")}"`);
    }
    if (rs.protocol) lines.push(`  ${prefix}.protocol: "${rs.protocol}"`);
    if (rs.profile) lines.push(`  ${prefix}.profile: "${rs.profile}"`);
    if (rs.allowlist?.length) {
      lines.push(`  ${prefix}.allowlist: "${rs.allowlist.join(",")}"`);
    }
    if (rs.blocklist?.length) {
      lines.push(`  ${prefix}.blocklist: "${rs.blocklist.join(",")}"`);
    }
    if (rs.geoBlock?.length) {
      lines.push(`  ${prefix}.geoblock: "${rs.geoBlock.join(",")}"`);
    }
    if (rs.geoAllow?.length) {
      lines.push(`  ${prefix}.geoallow: "${rs.geoAllow.join(",")}"`);
    }
    if (rs.rateLimit) {
      lines.push(`  ${prefix}.ratelimit: "${rs.rateLimit.rate}/s,burst=${rs.rateLimit.burst}"`);
    }
    if (rs.log) lines.push(`  ${prefix}.log: "true"`);
    if (rs.logPrefix) lines.push(`  ${prefix}.logPrefix: "${rs.logPrefix}"`);
  }
  return lines.join("\n") + "\n";
}

export function downloadTextFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/yaml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
