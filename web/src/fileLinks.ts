import { createContext, useContext } from "react";

// Lets transcript links and tool cards open files in the side pane.
export const OpenFileContext = createContext<(ref: string) => void>(() => {});
export const useOpenFile = () => useContext(OpenFileContext);
