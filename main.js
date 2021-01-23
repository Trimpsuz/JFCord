const {
	app,
	BrowserWindow,
	ipcMain,
	Tray,
	Menu,
	shell,
	dialog,
	Notification
} = require('electron');
const crypto = require('crypto');
const path = require('path');
const Store = require('electron-store');
const keytar = require('keytar');
const StartupHandler = require('./utils/startupHandler');
const MBClient = require('./utils/MBClient');
const DiscordRPC = require('discord-rpc');
const UpdateChecker = require('./utils/UpdateChecker');
const Logger = require('./utils/logger');
const serverDiscoveryClient = require('./utils/ServerDiscoveryClient');
const { scrubObject } = require('./utils/helpers');
const { version, name, author, homepage } = require('./package.json');
const {
	clientIds,
	UUID,
	iconUrl,
	updateCheckInterval,
	logRetentionCount,
	discordConnectRetryMS,
	MBConnectRetryMS,
	presenceUpdateIntervalMS
} = require('./config/default.json');

/**
 * @type {BrowserWindow}
 */
let mainWindow;

/**
 * @type {Tray}
 */
let tray;

/**
 * @type {MBClient}
 */
let mbc;

/**
 * @type {DiscordRPC.Client}
 */
let rpc;

let presenceUpdate;
let updateChecker;

(async () => {
	let encryptionKey = await keytar.getPassword(name, 'data');
	if (!encryptionKey) {
		encryptionKey = crypto.randomBytes(16).toString('hex');
		await keytar.setPassword(name, 'data', encryptionKey);
	}

	const store = new Store({
		encryptionKey,
		name: 'settings',
		defaults: {
			enableDebugLogging: false,
			isConfigured: false,
			doDisplayStatus: true,
			useTimeElapsed: false,
			serverType: 'emby',
			ignoredViews: [],
			username: '',
			password: '',
			port: '',
			serverAddress: '',
			protocol: ''
		}
	});
	const startupHandler = new StartupHandler(app, name);
	const checker = new UpdateChecker(author, name, version);
	const logger = new Logger(
		process.defaultApp ? 'console' : 'file',
		path.join(app.getPath('userData'), 'logs'),
		logRetentionCount,
		name,
		store.get('enableDebugLogging')
	);

	const startApp = () => {
		mainWindow = new BrowserWindow({
			width: 480,
			height: 310,
			minimizable: false,
			maximizable: false,
			webPreferences: {
				nodeIntegration: true
			},
			resizable: false,
			title: `Configure ${name}`,
			show: false
		});

		// only allow one instance
		const lockedInstance = app.requestSingleInstanceLock();
		if (!lockedInstance) return app.quit();

		// in development mode we allow resizing
		if (process.defaultApp) {
			mainWindow.resizable = true;
			mainWindow.maximizable = true;
			mainWindow.minimizable = true;
		} else {
			mainWindow.setMenu(null);
		}

		if (store.get('isConfigured')) {
			startPresenceUpdater();
			moveToTray();
		} else {
			loadConfigurationPage();
		}

		checkForUpdates();
		updateChecker = setInterval(checkForUpdates, updateCheckInterval);
	};

	const loadConfigurationPage = () => {
		// 	// if we dont set to resizable and we load lib configuration and then this window, it stays the same size as the lib configuration window (it doesnt do this for any other windows??)
		mainWindow.resizable = true;

		mainWindow.setSize(480, 310);
		mainWindow.loadFile(path.join(__dirname, 'static', 'configure.html'));

		if (!process.defaultApp) mainWindow.resizable = false;

		appBarHide(false);
	};

	const resetApp = () => {
		store.clear();

		stopPresenceUpdater();

		tray.destroy();

		loadConfigurationPage();
	};

	const toggleDisplay = () => {
		if (store.get('doDisplayStatus')) {
			logger.debug('doDisplayStatus disabled');
			stopPresenceUpdater();
			store.set('doDisplayStatus', false);
		} else {
			logger.debug('doDisplayStatus enabled');
			startPresenceUpdater();
			store.set('doDisplayStatus', true);
		}
	};

	const appBarHide = (doHide) => {
		if (doHide) {
			mainWindow.hide();
			if (process.platform === 'darwin') app.dock.hide();
		} else {
			mainWindow.show();
			if (process.platform === 'darwin') app.dock.show();
		}

		mainWindow.setSkipTaskbar(doHide);
	};

	const loadIgnoredLibrariesPage = () => {
		mainWindow.loadFile(
			path.join(__dirname, 'static', 'libraryConfiguration.html')
		);

		mainWindow.setSize(450, 500);

		mainWindow.addListener(
			'close',
			(closeNoExit = (e) => {
				e.preventDefault();
				mainWindow.hide();
				appBarHide(true);
				mainWindow.removeListener('close', closeNoExit);
			})
		);
		// for this window we ignore the event after it is closed

		appBarHide(false);
	};

	const stopPresenceUpdater = async () => {
		if (mbc) {
			await mbc.logout();
			mbc = null;
		}
		if (rpc) {
			rpc.clearActivity();
			rpc.destroy();
			rpc = null;
		}
		clearInterval(presenceUpdate);
	};

	const moveToTray = () => {
		tray = new Tray(path.join(__dirname, 'icons', 'tray.png'));

		const contextMenu = Menu.buildFromTemplate([
			{
				type: 'checkbox',
				label: 'Run at Startup',
				click: () => startupHandler.toggle(),
				checked: startupHandler.isEnabled
			},
			{
				type: 'checkbox',
				label: 'Display as Status',
				click: () => toggleDisplay(),
				checked: store.get('doDisplayStatus')
			},
			{
				label: 'Use Time Elapsed',
				type: 'checkbox',
				checked: store.get('useTimeElapsed'),
				click: () => {
					const isUsing = store.get('useTimeElapsed');

					store.set({ useTimeElapsed: !isUsing });
				}
			},
			{
				label: 'Set Ignored Libaries',
				click: () => loadIgnoredLibrariesPage()
			},
			{
				type: 'separator'
			},
			{
				label: 'Check for Updates',
				click: () => checkForUpdates(true)
			},
			{
				label: 'Enable Debug Logging',
				type: 'checkbox',
				checked: store.get('enableDebugLogging'),
				click: () => {
					const isEnabled = store.get('enableDebugLogging');

					logger.enableDebugLogging = !isEnabled;
					store.set({ enableDebugLogging: !isEnabled });
				}
			},
			{
				label: 'Show Logs',
				click: () => shell.openPath(logger.logPath)
			},
			{
				label: 'Reset App',
				click: () => resetApp()
			},
			{
				type: 'separator'
			},
			{
				label: 'Restart App',
				click: () => {
					app.quit();
					app.relaunch();
				}
			},
			{
				label: 'Quit',
				role: 'quit'
			},
			{
				type: 'separator'
			},
			{
				type: 'normal',
				label: `${name} v${version}`,
				enabled: false
			}
		]);

		tray.setToolTip(name);
		tray.setContextMenu(contextMenu);

		new Notification({
			title: `${name} ${version}`,
			body: `${name} has been minimized to the tray`
		}).show();

		appBarHide(true);
	};

	const checkForUpdates = (calledFromTray) => {
		checker.checkForUpdate((err, data) => {
			if (err) {
				if (calledFromTray) {
					dialog.showErrorBox(name, 'Failed to check for updates');
				}
				logger.error(err);
				return;
			}

			if (data.pending) {
				if (!calledFromTray) clearInterval(updateChecker);

				dialog.showMessageBox(
					{
						type: 'info',
						buttons: ['Okay', 'Get Latest Version'],
						message: 'A new version is available!',
						detail: `Your version is ${version}. The latest version currently available is ${data.version}`
					},
					(index) => {
						if (index === 1) {
							shell.openExternal(`${homepage}/releases/latest`);
						}
					}
				);
			} else if (calledFromTray) {
				dialog.showMessageBox({
					title: name,
					type: 'info',
					message: 'There are no new versions available to download'
				});
			}
		});
	};

	const connectRPC = () => {
		return new Promise((resolve) => {
			const data = store.get();

			rpc = new DiscordRPC.Client({ transport: 'ipc' });
			rpc
				.login({ clientId: clientIds[data.serverType] })
				.then(() => resolve())
				.catch(() => {
					logger.error(
						`Failed to connect to Discord. Attempting to reconnect in ${
							discordConnectRetryMS / 1000
						} seconds`
					);

					setTimeout(connectRPC, discordConnectRetryMS);
				});

			rpc.transport.once('close', () => {
				rpc.destroy();
				rpc = null; // prevent cannot read property write of null errors

				logger.warn(
					`Discord RPC connection closed. Attempting to reconnect in ${
						discordConnectRetryMS / 1000
					} seconds`
				);

				setTimeout(connectRPC, discordConnectRetryMS);
			});

			rpc.transport.once('open', () => {
				logger.info('Connected to Discord');
			});
		});
	};

	const startPresenceUpdater = async () => {
		const data = store.get();

		if (!mbc) {
			mbc = new MBClient(
				{
					address: data.serverAddress,
					username: data.username,
					password: data.password,
					protocol: data.protocol,
					port: data.port
				},
				{
					deviceName: name,
					deviceId: UUID,
					deviceVersion: version,
					iconUrl: iconUrl
				}
			);
		}

		logger.debug('Attempting to log into server');
		logger.debug(scrubObject(data, 'username', 'password', 'serverAddress'));

		await connectRPC();

		try {
			await mbc.login();
		} catch (err) {
			logger.error('Failed to authenticate. Retrying in 30 seconds.');
			logger.error(err);
			setTimeout(startPresenceUpdater, MBConnectRetryMS);
			return; // yeah no sorry buddy we don't want to continue if we didn't authenticate
		}

		setPresence();
		presenceUpdate = setInterval(setPresence, presenceUpdateIntervalMS);
	};

	const setPresence = async () => {
		const data = store.get();

		try {
			let sessions;

			try {
				sessions = await mbc.getSessions();
			} catch (err) {
				return logger.error(`Failed to get sessions: ${err}`);
			}

			const session = sessions.find(
				(session) =>
					session.NowPlayingItem !== undefined &&
					session.UserName.toLowerCase() === data.username.toLowerCase()
			);

			if (session) {
				const NPItem = session.NowPlayingItem;

				const NPItemLibraryID = await mbc.getItemInternalLibraryId(NPItem.Id);
				if (store.get('ignoredViews').includes(NPItemLibraryID)) {
					// prettier-ignore
					logger.debug(`${NPItem.Name} is in library with ID ${NPItemLibraryID} which is on the ignored library list, will not set status`);
					if (rpc) rpc.clearActivity();
					return;
				}

				logger.debug(session);

				const currentEpochSeconds = new Date().getTime() / 1000;
				const startTimestamp = Math.round(currentEpochSeconds - Math.round(session.PlayState.PositionTicks / 10000 / 1000));
				const endTimestamp = Math.round(
					currentEpochSeconds +
						Math.round(
							(session.NowPlayingItem.RunTimeTicks - session.PlayState.PositionTicks) / 10000 / 1000
						)
				);

				logger.debug(
					`Time until media end: ${endTimestamp - currentEpochSeconds}, been playing since: ${startTimestamp}`
				);

				setTimeout(
					setPresence,
					(endTimestamp - currentEpochSeconds) * 1000 + 1500
				);

				const defaultProperties = {
					largeImageKey: 'large',
					largeImageText: `${
						NPItem.Type === 'Audio' ? 'Listening' : 'Watching'
					} on ${session.Client}`,
					smallImageKey: session.PlayState.IsPaused ? 'pause' : 'play',
					smallImageText: session.PlayState.IsPaused ? 'Paused' : 'Playing',
					instance: false
				};

				if (!session.PlayState.IsPaused) {
					data.useTimeElapsed ? defaultProperties.startTimestamp = startTimestamp : defaultProperties.endTimestamp = endTimestamp;
				}

				logger.debug(defaultProperties);

				switch (NPItem.Type) {
					case 'Episode':
						// prettier-ignore
						const seasonNum = NPItem.ParentIndexNumber
						// prettier-ignore
						const episodeNum = NPItem.IndexNumber;

						rpc.setActivity({
							details: `Watching ${NPItem.SeriesName} ${
								NPItem.ProductionYear ? `(${NPItem.ProductionYear})` : ''
							}`,
							state: `${
								seasonNum ? `S${seasonNum.toString().padStart(2, '0')}` : ''
							}${
								episodeNum ? `E${episodeNum.toString().padStart(2, '0')}: ` : ''
							}${NPItem.Name}`,
							...defaultProperties
						});
						break;
					case 'Movie':
						rpc.setActivity({
							details: 'Watching a Movie',
							state: `${NPItem.Name} ${
								NPItem.ProductionYear && `(${NPItem.ProductionYear})`
							}`,
							...defaultProperties
						});
						break;
					case 'MusicVideo':
						// kill yourself i needed to redeclare it
						var artists = NPItem.Artists.splice(0, 2); // we only want 2 artists

						rpc.setActivity({
							details: `Watching ${NPItem.Name} ${
								NPItem.ProductionYear ? `(${NPItem.ProductionYear})` : ''
							}`,
							state: `By ${
								artists.length ? artists.join(', ') : 'Unknown Artist'
							}`,
							...defaultProperties
						});
						break;
					case 'Audio':
						var artists = NPItem.Artists.splice(0, 2);
						var albumArtists = NPItem.AlbumArtists.map(
							(ArtistInfo) => ArtistInfo.Name
						).splice(0, 2);

						rpc.setActivity({
							details: `Listening to ${NPItem.Name} ${
								NPItem.ProductionYear ? `(${NPItem.ProductionYear})` : ''
							}`,
							state: `By ${
								artists.length
									? artists.join(', ')
									: albumArtists.length
									? albumArtists.join(', ')
									: 'Unknown Artist'
							}`,
							...defaultProperties
						});
						break;
					default:
						rpc.setActivity({
							details: 'Watching Other Content',
							state: NPItem.Name,
							...defaultProperties
						});
				}
			} else {
				logger.debug('No session, clearing activity');
				if (rpc) rpc.clearActivity();
			}
		} catch (error) {
			logger.error(`Failed to set activity: ${error}`);
		}
	};

	ipcMain.on('RECEIVE_SERVERS', async (event) => {
		let jellyfinServers = [];
		let embyServers = [];

		try {
			jellyfinServers = await serverDiscoveryClient.find(1750, 'jellyfin');
		} catch (err) {
			jellyfinServers = [];
			logger.error('Failed to get Jellyfin servers');
			logger.error(err);
		}

		try {
			embyServers = await serverDiscoveryClient.find(1750, 'emby');
		} catch (err) {
			embyServers = [];
			logger.error('Failed to get Emby servers');
			logger.error(err);
		}

		const servers = [
			// prettier-ignore
			...embyServers,
			...jellyfinServers
		];

		logger.debug(`Server discovery result: ${JSON.stringify(servers)}`);

		event.reply('RECEIVE_SERVERS', servers);
	});

	ipcMain.on('VIEW_SAVE', (_, data) => {
		const ignoredViews = store.get('ignoredViews');

		if (ignoredViews.includes(data)) {
			ignoredViews.splice(ignoredViews.indexOf(data), 1);
		} else {
			ignoredViews.push(data);
		}

		store.set({
			ignoredViews
		});
	});

	ipcMain.on('TYPE_CHANGE', (_, data) => {
		switch (data) {
			case 'jellyfin':
				store.set({ serverType: 'jellyfin' });
				break;
			case 'emby':
				store.set({ serverType: 'emby' });
				break;
		}
	});

	ipcMain.on('RECEIVE_VIEWS', async (event) => {
		let userViews;

		if (!mbc.isAuthenticated) {
			// Not authed yet
			logger.info('Attempting to authenticate');
			try {
				await mbc.login();
			} catch (err) {
				event.reply('FETCH_FAILED');
				dialog.showErrorBox(
					name,
					'Failed to fetch libraries for your user. Please try the reload button.'
				);

				logger.error('Failed to authenticate');
				logger.error(err);
			}
		}

		try {
			userViews = await mbc.getUserViews();
		} catch (err) {
			event.reply('FETCH_FAILED');
			dialog.showErrorBox(
				name,
				'Failed to fetch libraries for your user. Please try the reload button.'
			);
			logger.error(err);

			return;
		}

		const viewData = {
			availableViews: userViews,
			ignoredViews: store.get('ignoredViews')
		};

		logger.debug('Sending view data to renderer');
		logger.debug(viewData);

		event.reply('RECEIVE_VIEWS', viewData);
	});

	ipcMain.on('CONFIG_SAVE', async (_, data) => {
		const emptyFields = Object.entries(data)
			.filter((entry) => !entry[1] && entry[0] !== 'password') // where entry[1] is the value, and if the field password is ignore it (emby and jelly dont require pws)
			.map((field) => field[0]); // we map empty fields by their names

		if (emptyFields.length) {
			mainWindow.webContents.send('VALIDATION_ERROR', emptyFields);
			dialog.showMessageBox(mainWindow, {
				title: name,
				type: 'error',
				detail: 'Please make sure that all the fields are filled in!'
			});
			return;
		}

		mbc = new MBClient(
			{
				address: data.serverAddress,
				username: data.username,
				password: data.password,
				protocol: data.protocol,
				port: data.port
			},
			{
				deviceName: name,
				deviceId: UUID,
				deviceVersion: version,
				iconUrl: iconUrl
			}
		);

		logger.debug('Attempting to log into server');
		logger.debug(scrubObject(data, 'username', 'password', 'serverAddress'));

		try {
			await mbc.login();
		} catch (error) {
			logger.error(error);
			dialog.showMessageBox(mainWindow, {
				type: 'error',
				title: name,
				detail: 'Invalid server address or login credentials'
			});
			return;
		}

		store.set({ ...data, isConfigured: true, doDisplayStatus: true });

		moveToTray();
		startPresenceUpdater();
	});

	ipcMain.on('RECEIVE_TYPE', (event) => {
		event.reply('RECEIVE_TYPE', store.get('serverType'));
	});

	if (app.isReady()) {
		startApp();
	} else {
		app.once('ready', startApp);
	}
})();
