import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FirewallBadge, UnlistedPortsBadge } from "./FirewallBadge";

describe("FirewallBadge", () => {
  it("shows a spinner marker while a change is in flight", () => {
    render(<FirewallBadge status="disabled" pending="apply" />);
    expect(screen.getByText("Off")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("applying…");
  });

  it("shows a muted not confirmed marker after the agent stayed silent", () => {
    render(<FirewallBadge status="active" pending="unconfirmed" />);
    expect(screen.getByText("not confirmed")).toHaveAttribute(
      "title",
      expect.stringContaining("has not reported the new state"),
    );
    expect(screen.queryByText("turning off…")).not.toBeInTheDocument();
  });
});

describe("UnlistedPortsBadge", () => {
  it("names the policy in plain words and keeps the raw value in the tooltip", () => {
    render(<UnlistedPortsBadge policy="DROP" />);
    expect(screen.getByText("Blocked")).toHaveAttribute("title", expect.stringContaining("DROP"));
  });
});
