// Applies the saved light/dark theme before first paint (was an inline script).
try{var t=localStorage.getItem('sw-theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t;else if(matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.dataset.theme='dark'}catch(e){}
