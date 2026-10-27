import "@civicalert/api-core/env";
import { createApi, startScheduledAnnouncementWorker } from "@civicalert/api-core/server";
const port = Number(process.env.CEPALCO_API_PORT || process.env.PORT || 4102);
startScheduledAnnouncementWorker("cepalco");
createApi("cepalco").listen(port, () => console.log(`CEPALCO API listening at http://localhost:${port}`));
