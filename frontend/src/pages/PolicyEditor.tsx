import { useMemo } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { useTheme } from "next-themes";

type Props = {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  id?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  placeholder?: string;
  height?: string;
};

export default function PolicyEditor({
  value,
  onChange,
  className,
  id,
  ariaLabelledBy,
  ariaDescribedBy,
  placeholder,
  height = "260px",
}: Props) {
  const { resolvedTheme } = useTheme();
  const extensions = useMemo(() => {
    const attrs: Record<string, string> = {};
    if (id) attrs.id = id;
    if (ariaLabelledBy) attrs["aria-labelledby"] = ariaLabelledBy;
    if (ariaDescribedBy) attrs["aria-describedby"] = ariaDescribedBy;
    return Object.keys(attrs).length > 0
      ? [javascript(), EditorView.contentAttributes.of(attrs)]
      : [javascript()];
  }, [id, ariaLabelledBy, ariaDescribedBy]);
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      height={height}
      placeholder={placeholder}
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      className={className ?? "font-mono text-xs border rounded w-full min-h-[260px]"}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: true,
        foldGutter: false,
      }}
    />
  );
}
