const path = require("path");
const { app, BrowserWindow, ipcMain, Tray, Menu, shell, dialog } = require("electron");
const DiscordRPC = require("discord-rpc");
const request = require("request");
const ws = require("ws");
const Startup = require("./utils/startupHandler");
const JsonDB = require("./utils/JsonDB");
const Logger = require("./utils/logger");
const { toZero } = require("./utils/utils");
const { version, name, author, homepage } = require("./package.json");
const { clientIds, UUID, iconUrl } = require("./config/default.json");

const logger = new Logger((process.defaultApp ? "console" : "file"), app.getPath("userData"));
const db = new JsonDB(path.join(app.getPath("userData"), "config.json"));
const startupHandler = new Startup(app);

let rpc;
let mainWindow;
let tray;
let accessToken;
let wsconn;

async function startApp() {
    mainWindow = new BrowserWindow({
        width: 480,
        height: 310,
        minimizable: false,
        maximizable: false,
        webPreferences: {
            nodeIntegration: true
        },
        resizable: false,
        title: `Configure ${name}`
    });

    setTimeout(checkUpdates, 2500);

    const lock = app.requestSingleInstanceLock();
    if(!lock) {
        app.quit(); // quit if multiple instances are found....
    }

    // check env to allow dev tools and resizing.......
    if(process.defaultApp) {
        mainWindow.setResizable(true);
        mainWindow.setMaximizable(true);
        mainWindow.setMinimizable(true);
    } else {
        mainWindow.setMenu(null);
    }

    if(db.data().isConfigured === true) {
        if(db.data().doDisplayStatus === undefined) db.write({ doDisplayStatus: true }); // for existing installations that do not have doDisplayStatus in their config. This could be removed in future releases.
        moveToTray();
        connectRPC();
    } else {
        if(!db.data().serverType) db.write({ serverType: "emby" });
        await mainWindow.loadFile(path.join(__dirname, "static", "configure.html"));
        mainWindow.webContents.send("config-type", db.data().serverType);
    }
}

ipcMain.on("theme-change", (_, data) => {
    switch(data) {
        case "jellyfin":
            db.write({ serverType: "jellyfin" });
            break;
        case "emby":
            db.write({ serverType: "emby" });
            break;
    }
});

function moveToTray() {
    tray = new Tray(path.join(__dirname, "icons", "tray.png"));

    const contextMenu = Menu.buildFromTemplate([
        {
            type: "checkbox",
            label: "Run at Startup",
            click: () => startupHandler.toggle(),
            checked: startupHandler.isEnabled
        },
        {
            type: "checkbox",
            label: "Display as Status",
            click: () => toggleDisplay(),
            checked: db.data().doDisplayStatus
        },
        {
            type: "separator"
        },
        {
            label: "Show Logs",
            click: () => shell.openItem(logger.logPath)
        },
        {
            label: "Reset App",
            click: () => resetApp()
        },
        {
            type: "separator"
        },
        {
            label: "Restart App",
            click: () => {
                app.quit();
                app.relaunch();
            }
        },
        {
            label: "Quit",
            role: "quit"
        }
    ]);

    tray.setToolTip(`${name} - ${version}`);
    tray.setContextMenu(contextMenu);

    mainWindow.setSkipTaskbar(true); // hide for windows specifically
    mainWindow.hide();

    dialog.showMessageBox({ 
        type: "info", 
        title: name, 
        message: `${name} has been minimized to the tray`
    });

    if(process.platform === "darwin") app.dock.hide(); // hide from dock on macos
}

function toggleDisplay() {
    let doDisplay = db.data().doDisplayStatus;

    if(doDisplay) {
        db.write({ doDisplayStatus: false });
        rpc.clearActivity();
        if(wsconn) wsconn = null;
    } else {
        db.write({ doDisplayStatus: true });

        connectRPC();
    }

    return;
}

async function resetApp() {
    db.write({ isConfigured: false });

    accessToken = null;

    if(wsconn) wsconn.close();

    if(rpc) rpc.clearActivity();
    
    await mainWindow.loadFile(path.join(__dirname, "static", "configure.html"));

    mainWindow.webContents.send("config-type", db.data().serverType);

    tray.destroy();
}

ipcMain.on("config-save", async (_, data) => {
    const emptyFields = Object.entries(data)
        .filter(field => !field[1])
        .map(field => field[0]);

    if(emptyFields.length > 0) {
        mainWindow.webContents.send("validation-error", emptyFields);
        dialog.showErrorBox(name, "Please make sure that all the fields are filled in");
        return;
    }

    try {
        accessToken = await getToken(data.username, data.password, data.serverAddress, data.port, data.protocol, version, name, UUID, iconUrl);

        db.write({ ...data, isConfigured: true, doDisplayStatus: true });

        moveToTray();
        connectRPC();
    } catch (error) {
        logger.log(error);
        dialog.showErrorBox(name, "Invalid server address or login credentials");
    }
});

function getToken(username, password, serverAddress, port, protocol, deviceVersion, deviceName, deviceId, IconUrl) {
    return new Promise((resolve, reject) => {
        request.post(`${protocol}://${serverAddress}:${port}/emby/Users/AuthenticateByName`, {
                headers: {
                    Authorization: `Emby Client=Other, Device=${deviceName}, DeviceId=${deviceId}, Version=${deviceVersion}`
                },
                body: {
                    "Username": username,
                    "Pw": password
                },
                json: true
            }, (err, res, body) => {
                if(err) return reject(err);
                if(res.statusCode !== 200) return reject(`Failed to authenticate. Status: ${res.statusCode}. Reason: ${body}`);

                // set device icon
                request.post(`${protocol}://${serverAddress}:${port}/emby/Sessions/Capabilities/Full`, {
                    headers: {
                        "X-Emby-Token": body.AccessToken
                    },
                    body: {
                        IconUrl
                    },
                    json: true
                }, (err, res) => {
                    if(err) return logger.log(`Failed to set device icon: ${err}`);
                    if(res.statusCode !== 200 && res.statusCode !== 204) return logger.log(`Failed to set device icon. Status: ${res.statusCode}`);
                });

                resolve(body.AccessToken);
            });
    })
}

function connectRPC() {
    const data = db.data();

    if(data.isConfigured && data.doDisplayStatus) {
        rpc = new DiscordRPC.Client({ transport: "ipc" });
        rpc.login({ clientId: clientIds[db.data().serverType] })
            .then(async () => {
                if(!accessToken) accessToken = await getToken(data.username, data.password, data.serverAddress, data.port, data.protocol, version, name, UUID, iconUrl)
                    .catch(err => {
                        logger.log(err);
                        return setTimeout(connectRPC, 15000);
                    });

                wsconn = new ws(`${data.protocol === "http" ? "ws" : "wss"}://${data.serverAddress}:${data.port}?api_key=${accessToken}&deviceId=${UUID}`)
            
                setPresence(); // initial status (get playback that might already be playing)

                wsconn.on("message", wsData => {
                    wsData = JSON.parse(wsData);

                    if(wsData.MessageType === "Sessions" || wsData.MessageType === "UserDataChanged") {
                        setPresence();
                    }
                });

                wsconn.on("open", () => {
                    logger.log("Websocket connection opened");
                    wsconn.send(JSON.stringify({ MessageType: "SessionsStart", Data: "0,1500,900" })); // "subscribe" to more session events
                });

                wsconn.on("close", () => {
                    logger.log("Websocket closed, attempting to reopen connection");
                    setTimeout(connectRPC, 15000);
                });
            })
            .catch(() => {
                setTimeout(connectRPC, 15000);
            });

        rpc.transport.once("open", () => {
            logger.log("Discord RPC connection established")
        });

        rpc.transport.once("close", () => {
            if(wsconn) wsconn.close();
            connectRPC();
            logger.log("Discord RPC connection terminated. Attempting to reconnect.");
        });
    } 
}

async function setPresence() {
    const data = db.data();

    if(!accessToken) accessToken = await getToken(data.username, data.password, data.serverAddress, data.port, data.protocol, version, name, UUID, iconUrl)
        .catch(err => logger.log(err));

    request(`${data.protocol}://${data.serverAddress}:${data.port}/emby/Sessions`, {
        headers: {
            "X-Emby-Token": accessToken
        },
        json: true
    }, (err, res, body) => {
        if(err) return logger.log(`Failed to authenticate: ${err}`);
        if(res.statusCode !== 200) return logger.log(`Failed to authenticated: ${res.statusCode}. Reason: ${body}`);

        const session = body.filter(session => 
            session.UserName === data.username && 
            session.DeviceName !== name &&
            session.NowPlayingItem)[0];
            
            if(session) {
                const currentEpochSeconds = new Date().getTime() / 1000; 
                const NPItem = session.NowPlayingItem;
                const endTimestamp = Math.round((currentEpochSeconds + Math.round(((NPItem.RunTimeTicks - session.PlayState.PositionTicks) / 10000) / 1000)));
                
                switch(NPItem.Type) {
                    case "Episode":
                        rpc.setActivity({
                            details: NPItem.SeriesName,
                            state: NPItem.ParentIndexNumber && NPItem.IndexNumber ? `S${toZero(NPItem.ParentIndexNumber)}E${toZero(NPItem.IndexNumber)}: ${NPItem.Name}` : NPItem.Name,
                            largeImageKey: "large",
                            largeImageText: `Watching on ${session.Client}`,
                            smallImageKey: session.PlayState.IsPaused ? "pause" : "play",
                            smallImageText: session.PlayState.IsPaused ? "Paused" : "Playing",
                            instance: false,
                            endTimestamp: !session.PlayState.IsPaused && endTimestamp
                        });
                        break;
                    case "Movie":
                        rpc.setActivity({
                            details: "Watching a Movie",
                            state: NPItem.Name,
                            largeImageKey: "large",
                            largeImageText: `Watching on ${session.Client}`,
                            smallImageKey: session.PlayState.IsPaused ? "pause" : "play",
                            smallImageText: session.PlayState.IsPaused ? "Paused" : "Playing",
                            instance: false,
                            endTimestamp: !session.PlayState.IsPaused && endTimestamp
                        });
                        break;
                    case "Audio": 
                        rpc.setActivity({
                            details: `Listening to ${NPItem.Name}`,
                            state: NPItem.AlbumArtist && `By ${NPItem.AlbumArtist}`,
                            largeImageKey: "large",
                            largeImageText: `Listening on ${session.Client}`,
                            smallImageKey: session.PlayState.IsPaused ? "pause" : "play",
                            smallImageText: session.PlayState.IsPaused ? "Paused" : "Playing",
                            instance: false,
                            endTimestamp: !session.PlayState.IsPaused && endTimestamp
                        });
                        break;
                    default: 
                        rpc.setActivity({
                            details: "Watching Other Content",
                            state: NPItem.Name,
                            largeImageKey: "large",
                            largeImageText: `Watching on ${session.Client}`,
                            smallImageKey: session.PlayState.IsPaused ? "pause" : "play",
                            smallImageText: session.PlayState.IsPaused ? "Paused" : "Playing",
                            instance: false,
                            endTimestamp: !session.PlayState.IsPaused && endTimestamp
                        });
                }   
        } else {
            if(rpc) rpc.clearActivity();
        }
    });
}

function checkUpdates() {
    request(`https://api.github.com/repos/${author}/${name}/releases/latest`, 
        {
            headers: {
                "User-Agent": name
            }
        },
    (err, _, body) => {
        if(err) return logger.log(err);
    
        body = JSON.parse(body);
    
        if(body.tag_name !== version) {
            dialog.showMessageBox({
                type: "info",
                buttons: ["Maybe Later", "Get Latest Version"],
                message: "A new version is available!",
                detail: `Your version is ${version}. The latest version is ${body.tag_name}. Would you like to download it?`
            }, index => {
                if(index === 1) {
                    shell.openExternal(`${homepage}/releases/latest`);
                }
            });
        }
    });
}

app.on("ready", () => startApp());

app.on('window-all-closed', () => {
    app.quit();
});

process
    .on("unhandledRejection", (reason, p) => logger.log(`${reason} at ${p}`))