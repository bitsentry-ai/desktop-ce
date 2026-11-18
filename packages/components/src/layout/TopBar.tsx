import { getDesktopApi } from "../services/desktop-api";

const desktopApi = getDesktopApi();
const desktopPlatform = desktopApi?.platform?.os;
const isDesktop = desktopApi !== undefined;
const reserveOverlayInset =
  desktopPlatform === "win32" || desktopPlatform === "linux";

/**
 * Window chrome above the page content. The browser needs none. On macOS the
 * traffic lights sit over the sidebar, so the page header itself is the drag
 * area (see `.bs-page-header`) and only a thin strip is kept for pages without
 * one. Windows and Linux keep a full bar for the overlay window controls.
 */
const TopBar = () => {
  if (!isDesktop) {
    return null;
  }
  if (reserveOverlayInset) {
    return (
      <div className="drag-region flex h-12 items-center px-4 pr-[140px] lg:px-6" />
    );
  }

  return (
    <div
      aria-hidden="true"
      className="drag-region pointer-events-auto fixed inset-x-0 top-0 z-40 h-2"
    />
  );
};

export default TopBar;
