import { getDesktopApi } from "../services/desktop-api";

const desktopApi = getDesktopApi();
const desktopPlatform = desktopApi?.platform?.os;
const isDesktop = desktopApi !== undefined;
const reserveOverlayInset =
  desktopPlatform === "win32" || desktopPlatform === "linux";

const TopBar = () => {
  let className = "h-6 flex items-center px-4 lg:px-6";
  if (isDesktop) {
    className = "drag-region h-12 flex items-center px-4 lg:px-6";
  }
  if (reserveOverlayInset) {
    className = `${className} pr-[140px]`;
  }

  return (
    <div
      className={className}
    />
  );
};

export default TopBar;
