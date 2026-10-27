import "@civicalert/api-core/env";
import { createApi, startScheduledAnnouncementWorker } from "@civicalert/api-core/server";
const port = Number(process.env.WATER_API_PORT || process.env.PORT || 4103);
startScheduledAnnouncementWorker("water");
createApi("water").listen(port, () => console.log(`Water District API listening at http://localhost:${port}`));
