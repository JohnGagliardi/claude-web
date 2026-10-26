import type { ReactNode } from "react";

// 16px stroke icons in the style of the desktop app's top bar.
const Svg = ({ children }: { children: ReactNode }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const DiffIcon = () => (
  <Svg>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="18" cy="18" r="2.5" />
    <path d="M13 6h3a2 2 0 0 1 2 2v7.5" />
    <path d="M11 18H8a2 2 0 0 1-2-2V8.5" />
    <path d="m15 3-2 3 2 3" />
    <path d="m9 21 2-3-2-3" />
  </Svg>
);

export const BranchIcon = () => (
  <Svg>
    <circle cx="6" cy="5" r="2.2" />
    <circle cx="6" cy="19" r="2.2" />
    <circle cx="18" cy="7" r="2.2" />
    <path d="M6 7.2v9.6" />
    <path d="M18 9.2c0 5-6 4-11 7.8" />
  </Svg>
);

export const TerminalIcon = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="m7.5 9.5 3 2.5-3 2.5" />
    <path d="M13 15h4" />
  </Svg>
);

export const GlobeIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
  </Svg>
);

export const ForkIcon = () => (
  <Svg>
    <circle cx="6" cy="5" r="2.2" />
    <circle cx="18" cy="5" r="2.2" />
    <circle cx="12" cy="19" r="2.2" />
    <path d="M6 7.2v1.3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7.2" />
    <path d="M12 11.5v5.3" />
  </Svg>
);

export const PanelIcon = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M15 4v16" />
  </Svg>
);

export const CloseIcon = () => (
  <Svg>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const BackIcon = () => (
  <Svg>
    <path d="M15 5 8 12l7 7" />
  </Svg>
);

export const FolderIcon = () => (
  <Svg>
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.2h7.4A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />
  </Svg>
);

export const ChatIcon = () => (
  <Svg>
    <path d="M20 12.5a7.5 7.5 0 0 1-11 6.6L4 20l1-4.2A7.5 7.5 0 1 1 20 12.5z" />
  </Svg>
);

export const TasksIcon = () => (
  <Svg>
    <path d="M3 12h3.5l2.5-6 4 12 2.5-6H21" />
  </Svg>
);

export const RailIcon = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M9 4v16" />
  </Svg>
);

export const LaptopIcon = () => (
  <Svg>
    <rect x="4.5" y="5" width="15" height="10.5" rx="1.5" />
    <path d="M2.5 19h19" />
  </Svg>
);

export const GearIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.8v2.4M12 18.8v2.4M4.2 7.5l2.1 1.2M17.7 15.3l2.1 1.2M4.2 16.5l2.1-1.2M17.7 8.7l2.1-1.2" />
    <circle cx="12" cy="12" r="7" />
  </Svg>
);

export const CodeIcon = () => (
  <Svg>
    <path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14" />
  </Svg>
);

export const StopIcon = () => (
  <Svg>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Svg>
);

export const UndoIcon = () => (
  <Svg>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
);

export const AgentIcon = () => (
  <Svg>
    <rect x="5" y="8" width="14" height="11" rx="3" />
    <path d="M12 4.5V8M9.5 13h.01M14.5 13h.01" />
  </Svg>
);
