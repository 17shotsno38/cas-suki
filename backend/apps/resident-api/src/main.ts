import "@civicalert/api-core/env";
import { createApi } from "@civicalert/api-core/server";
const port = Number(process.env.RESIDENT_API_PORT || process.env.PORT || 4101);
createApi("resident").listen(port, () => console.log(`Resident API listening at http://localhost:${port}`));
