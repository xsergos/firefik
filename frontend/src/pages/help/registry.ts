import type { ComponentType } from "react";
import {
  Overview,
  FleetStatuses,
  AddHost,
  ProtectContainer,
  ContainersHelp,
  RulesHelp,
  TrafficHelp,
  HistoryHelp,
  PoliciesHelp,
  TemplatesHelp,
  ApprovalsHelp,
  ProposalsHelp,
  TokensHelp,
  Troubleshooting,
} from "./sections";

export interface HelpSection {
  id: string;
  group: string;
  title: string;
  panelOnly?: boolean;
  Component: ComponentType;
}

export const HELP_SECTIONS: HelpSection[] = [
  { id: "overview", group: "Basics", title: "Firefik in one minute", Component: Overview },
  {
    id: "fleet",
    group: "Basics",
    title: "Reading the Fleet page",
    panelOnly: true,
    Component: FleetStatuses,
  },
  {
    id: "add-host",
    group: "Basics",
    title: "Adding a new host",
    panelOnly: true,
    Component: AddHost,
  },
  {
    id: "protect",
    group: "Protecting containers",
    title: "Protecting a container",
    Component: ProtectContainer,
  },
  {
    id: "containers",
    group: "Protecting containers",
    title: "Finding a container",
    Component: ContainersHelp,
  },
  {
    id: "rules",
    group: "Protecting containers",
    title: "Checking applied rules",
    Component: RulesHelp,
  },
  { id: "traffic", group: "Watching", title: "Who is knocking", Component: TrafficHelp },
  { id: "history", group: "Watching", title: "Who changed what", Component: HistoryHelp },
  { id: "policies", group: "Advanced", title: "Policies", Component: PoliciesHelp },
  {
    id: "templates",
    group: "Advanced",
    title: "Templates",
    panelOnly: true,
    Component: TemplatesHelp,
  },
  {
    id: "approvals",
    group: "Advanced",
    title: "Approvals",
    panelOnly: true,
    Component: ApprovalsHelp,
  },
  { id: "proposals", group: "Advanced", title: "Proposals", Component: ProposalsHelp },
  {
    id: "tokens",
    group: "Advanced",
    title: "Agent tokens",
    panelOnly: true,
    Component: TokensHelp,
  },
  {
    id: "troubleshooting",
    group: "Help",
    title: "When something looks wrong",
    Component: Troubleshooting,
  },
];
