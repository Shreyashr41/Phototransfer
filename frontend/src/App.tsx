import { useEffect, useState } from "react";
import { getInfo } from "./api";
import Dashboard from "./Dashboard";
import Mobile from "./Mobile";

export default function App() {
  const path = location.pathname.replace(/\/+$/, "");
  const [ready, setReady] = useState(path === "/m");

  useEffect(() => {
    if (path === "/m") return;
    // A phone that lands on the dashboard URL is sent to the mobile page.
    getInfo()
      .then((info) => {
        if (!info.is_local) location.replace("/m");
        else setReady(true);
      })
      .catch(() => setReady(true));
  }, [path]);

  if (path === "/m") return <Mobile />;
  return ready ? <Dashboard /> : null;
}
