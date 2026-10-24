import { createContext, useContext } from "react";

// Lets transcript links and tool cards open files in the side pane.
export const OpenFileContext = createContext<(ref: string) => void>(() => {});
export const useOpenFile = () => useContext(OpenFileContext);

// Which session a transcript belongs to, for loading subagent transcripts.
export const SessionContext = createContext<{ sessionId?: string; cwd: string }>({ cwd: "" });
export const useSession = () => useContext(SessionContext);

// Lets next-step buttons in the transcript answer as the user.
export const ReplyContext = createContext<{ send?: (text: string) => void; running: boolean }>({ running: false });
export const useReply = () => useContext(ReplyContext);
