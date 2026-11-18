export interface ActorDisplay {
  label: string;
  title: string;
}

export function formatActor(raw: string | undefined | null): ActorDisplay {
  const value = (raw ?? "").trim();
  if (!value) return { label: "—", title: "" };
  const at = value.lastIndexOf("@");
  const who = at > 0 ? value.slice(0, at) : value;
  const ip = at > 0 ? value.slice(at + 1) : "";
  const suffix = ip ? ` (${ip})` : "";
  if (who.startsWith("fp:") || who === "anonymous") {
    return { label: `Operator token${suffix}`, title: value };
  }
  return { label: `${who}${suffix}`, title: value };
}
