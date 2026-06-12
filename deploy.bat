@echo off
echo Deploying to Vercel...
git add .
git commit -m "site update"
git push
echo Done! Check Vercel in 1 minute.
pause