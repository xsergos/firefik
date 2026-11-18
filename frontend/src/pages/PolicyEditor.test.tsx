import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import PolicyEditor from "./PolicyEditor";

vi.mock("@uiw/react-codemirror", () => ({
  EditorView: {
    contentAttributes: { of: (attrs: Record<string, string>) => ({ __attrs: attrs }) },
  },
  default: ({
    value,
    onChange,
    className,
    placeholder,
    height,
    extensions,
  }: {
    value: string;
    onChange: (v: string) => void;
    className?: string;
    placeholder?: string;
    height?: string;
    extensions?: unknown[];
  }) => (
    <textarea
      data-testid="policy-editor-cm"
      className={className}
      placeholder={placeholder}
      data-height={height}
      data-attrs={JSON.stringify(
        (extensions ?? [])
          .map((e) => (e as { __attrs?: Record<string, string> }).__attrs)
          .find(Boolean) ?? null,
      )}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

vi.mock("@codemirror/lang-javascript", () => ({
  javascript: () => ({ __tag: "js-extension" }),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("PolicyEditor", () => {
  it("passes the value through to the editor", () => {
    render(<PolicyEditor value="policy 'p' {}" onChange={() => {}} />);
    const ta = screen.getByTestId("policy-editor-cm") as HTMLTextAreaElement;
    expect(ta.value).toBe("policy 'p' {}");
  });

  it("invokes onChange when the user edits", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PolicyEditor value="" onChange={onChange} />);
    const ta = screen.getByTestId("policy-editor-cm");
    await user.type(ta, "abc");
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)?.[0];
    expect(typeof last).toBe("string");
  });

  it("applies the default className when none is supplied", () => {
    render(<PolicyEditor value="" onChange={() => {}} />);
    const ta = screen.getByTestId("policy-editor-cm");
    expect(ta.className).toContain("font-mono");
    expect(ta.className).toContain("border");
  });

  it("uses a custom className when provided", () => {
    render(<PolicyEditor value="" onChange={() => {}} className="my-custom" />);
    const ta = screen.getByTestId("policy-editor-cm");
    expect(ta.className).toBe("my-custom");
  });

  it("adds no content attributes and keeps the default height without a11y props", () => {
    render(<PolicyEditor value="" onChange={() => {}} />);
    const ta = screen.getByTestId("policy-editor-cm");
    expect(ta.getAttribute("data-attrs")).toBe("null");
    expect(ta.getAttribute("data-height")).toBe("260px");
  });

  it("passes id, label and description to the editable area and forwards placeholder and height", () => {
    render(
      <PolicyEditor
        value=""
        onChange={() => {}}
        id="body"
        ariaLabelledBy="body-label"
        ariaDescribedBy="body-hint"
        placeholder="type here"
        height="200px"
      />,
    );
    const ta = screen.getByTestId("policy-editor-cm");
    expect(JSON.parse(ta.getAttribute("data-attrs") ?? "null")).toEqual({
      id: "body",
      "aria-labelledby": "body-label",
      "aria-describedby": "body-hint",
    });
    expect(ta).toHaveAttribute("placeholder", "type here");
    expect(ta.getAttribute("data-height")).toBe("200px");
  });
});
