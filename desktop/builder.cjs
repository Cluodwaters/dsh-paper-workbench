const path = require("node:path");
const root = path.resolve(__dirname, "..");
module.exports = {
  appId: "org.paperworkbench.desktop",
  productName: "文献工作台",
  // The bundled ZIP extractor cannot decode UTF-8 archive entry names.
  // Keep internal binary names ASCII; the UI and shortcuts remain Chinese.
  executableName: "PaperWorkbench",
  copyright: "Paper Workbench contributors",
  directories: { output: path.join(root, "output/desktop-dist") },
  files: ["main.cjs", "close-guard.cjs", "package.json", "!node_modules/**/*"],
  extraResources: [
    { from: path.join(root, "output/desktop-stage/backend"), to: "backend" },
    // electron-builder deliberately skips root node_modules in a file matcher;
    // use an explicit matcher for the external Node backend's production graph.
    {
      from: path.join(root, "output/desktop-stage/backend/node_modules"),
      to: "backend/node_modules",
    },
    { from: path.join(root, "output/desktop-stage/runtime"), to: "runtime" },
  ],
  npmRebuild: false,
  asar: true,
  electronDist: path.join(root, "node_modules/electron/dist"),
  win: {
    target: ["nsis"],
    artifactName: "PaperWorkbench-${version}-win-x64-Setup.${ext}",
    signExecutable: false,
    icon: path.join(root, "resources/icon.ico"),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    // Extract directly to the selected directory. The 7z path uses the Windows
    // shell's CopyFiles, whose access failures are mislabeled as a running app.
    differentialPackage: false,
    useZip: true,
    include: path.join(__dirname, "installer.nsh"),
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "文献工作台",
    deleteAppDataOnUninstall: false,
    runAfterFinish: false,
  },
};
