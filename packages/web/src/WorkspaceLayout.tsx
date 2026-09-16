import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
} from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useLocation } from "wouter";
import { colors } from "maui";
import { style, useStyles } from "purse-styles";
import type { SessionSummary } from "@get-halo/client";
import type { AppInfo } from "./HostApi.js";
import { MainPane } from "./main/MainPane.js";
import { Sidebar } from "./sidebar/Sidebar.js";
import "./workspaceLayout.css";

const SidebarContext = createContext<{
  isMobile: boolean;
  open: () => void;
  close: () => void;
}>({ isMobile: false, open: () => {}, close: () => {} });

export function useSidebar() {
  return useContext(SidebarContext);
}

function subscribeToMobile(onChange: () => void) {
  const media = window.matchMedia("(max-width: 700px)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function isMobileScreen() {
  return window.matchMedia("(max-width: 700px)").matches;
}

export function WorkspaceLayout({
  sessions,
  appInfo,
}: {
  sessions: SessionSummary[];
  appInfo?: AppInfo;
}) {
  const isMobile = useSyncExternalStore(subscribeToMobile, isMobileScreen);
  const [location] = useLocation();
  const [sidebarState, setSidebarState] = useState({
    location,
    isMobile,
    isOpen: false,
  });
  if (
    sidebarState.location !== location ||
    sidebarState.isMobile !== isMobile
  ) {
    setSidebarState({ location, isMobile, isOpen: false });
  }
  function setIsOpen(isOpen: boolean) {
    setSidebarState({ location, isMobile, isOpen });
  }
  const shell = useStyles(shellStyle);
  const overlay = useStyles(overlayStyle);

  return (
    <SidebarContext
      value={{
        isMobile,
        open: () => setIsOpen(true),
        close: () => setIsOpen(false),
      }}
    >
      <div className={shell} data-testid="sessions-shell">
        {!isMobile && <Sidebar sessions={sessions} appInfo={appInfo} />}
        <MainPane sessions={sessions} />
      </div>
      <ModalOverlay
        isOpen={isMobile && sidebarState.isOpen}
        onOpenChange={setIsOpen}
        isDismissable
        className={overlay}
      >
        <Modal className="workspaceDrawer">
          <Dialog
            aria-label="Workspace navigation"
            className="workspaceDrawerDialog"
          >
            <Sidebar sessions={sessions} appInfo={appInfo} />
          </Dialog>
        </Modal>
      </ModalOverlay>
    </SidebarContext>
  );
}

const shellStyle = style({
  display: "grid",
  gridTemplateColumns: "240px minmax(0, 1fr)",
  width: "100%",
  height: "100dvh",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
  backgroundColor: colors.gray[4],
  "@media (max-width: 700px)": {
    gridTemplateColumns: "minmax(0, 1fr)",
  },
});

const overlayStyle = style({
  position: "fixed",
  inset: 0,
  height: "100dvh",
  zIndex: 100,
  backgroundColor: "rgb(0 0 0 / 35%)",
});
