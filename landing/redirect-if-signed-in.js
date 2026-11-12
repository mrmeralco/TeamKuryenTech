// Landing page is the front door for visitors who are NOT logged in.
// Fully signed-up users go straight to the dashboard.
import { currentUser, isComplete, goToDashboard } from "./auth.js";
currentUser().then(async (u) => { if (await isComplete(u)) goToDashboard(); }).catch(() => {});
