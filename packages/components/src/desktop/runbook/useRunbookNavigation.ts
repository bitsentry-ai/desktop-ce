import { useNavigate } from "react-router-dom";

export function useRunbookNavigation() {
  const navigate = useNavigate();

  const openRunbook = (runbookId: string) => {
    void navigate(`/runbooks?id=${runbookId}`);
  };

  const openRunbooks = () => {
    void navigate("/runbooks");
  };

  const openRunbookResults = (runbookId: string) => {
    void navigate(`/results?runbook=${runbookId}`);
  };

  const openResult = (resultId: string) => {
    void navigate(`/results?id=${resultId}`);
  };

  return {
    openResult,
    openRunbook,
    openRunbookResults,
    openRunbooks,
  };
}
