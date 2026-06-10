# Render Deployment

Auto-deploy is ON — Render deploys automatically on every git push to main.
Wait 2-3 minutes after push for deploy to complete.
Watch for `==> Your service is live 🎉` in Render logs before testing.
Only use Manual Deploy from Render dashboard if auto-deploy hasn't fired after 5 minutes.
Never add deploy hooks or manual curl commands — auto-deploy handles it.
