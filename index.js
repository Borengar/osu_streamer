const {app, BrowserWindow, ipcMain} = require('electron');
const {execFile} = require('child_process');
const path = require('path');
const url = require('url');
const fs = require('fs');
const tmi = require('tmi.js');
const https = require('https');
const request = require('request-promise');
const irc = require('irc');
const cheerio = require('cheerio');
const clientId = 'vf3g964qvdzd6905rdg5wyecwvlz9u';

var loginWindow;
var mainWindow;
var twitchClient;
var osuClient;
var accessToken;
var user;
var channel;
var viewers;
var requests;
var badges;
var config;
var levels;
var levelsTimer;
var eventTimer;
var npTimer;
var twitchMessageTimer;
var twitchMessageQueue = [];
var subOnlyOnCooldown = false;
var rankOnCooldown = false;

function createWindow() {
	loginWindow = new BrowserWindow({
		width: 500,
		height: 700
	});
	loginWindow.show();
	loginWindow.webContents.on('will-navigate', (event, newUrl) => {
		var hashParams = {};
    var e,
        a = /\+/g,  // Regex for replacing addition symbol with a space
        r = /([^&;=]+)=?([^&;]*)/g,
        d = function (s) { return decodeURIComponent(s.replace(a, " ")); };

    while (e = r.exec(newUrl.split('#')[1]))
       hashParams[d(e[1])] = d(e[2]);

    if (hashParams['access_token']) {
    	accessToken = hashParams['access_token'];
    	mainWindow = new BrowserWindow({
    		width: 1100,
    		height: 800,
    		show: false
    	});
    	mainWindow.once('ready-to-show', () => {
    		mainWindow.show();
    		loadConfig();
    		loadLevels();
    		loginWindow.close();
    		request({
	    		url: 'https://api.twitch.tv/kraken/user',
	    		headers: {
	    			'Accept': 'application/vnd.twitchtv.v5+json',
	    			'Client-ID': clientId,
	    			'Authorization': 'OAuth ' + accessToken
	    		}
	    	})
	    	.then((body) => {
	    		user = JSON.parse(body);
	    		return request('https://badges.twitch.tv/v1/badges/channels/' + user._id + '/display?language=en');
	    	})
	    	.then((body) => {
					badges = JSON.parse(body);
					if (badges.badge_sets.subscriber) {
						mainWindow.webContents.send('subBadge', badges.badge_sets.subscriber.versions['0'].image_url_1x);
					}
					return request({
						url: 'https://api.twitch.tv/kraken/channels/' + user._id,
						headers: {
							'Accept': 'application/vnd.twitchtv.v5+json',
							'Client-ID': clientId,
							'Authorization': 'OAuth ' + accessToken
						}
					});
				})
				.then((body) => {
					channel = JSON.parse(body);

					// debugging
					//channel.name = 'happystick';

					twitchLogin();
				})
	    	.catch((err) => {
	    		console.error(err);
	    	});
    	});
    	mainWindow.loadURL(url.format({
    		pathname: path.join(__dirname, 'index.html'),
    		protocol: 'file:',
    		slashes: true
    	}));
    }
	});
	loginWindow.loadURL('https://api.twitch.tv/kraken/oauth2/authorize?client_id=' + clientId + '&redirect_uri=http://localhost&response_type=token&scope=chat_login+channel_check_subscription+user_read&force_verify=true');
}

function deleteViewerFiles(callback) {
	var i = 0;
	var fileFound = true;
	while (fileFound) {
		if (fs.existsSync(config.viewers.filePath + i + '.txt')) {
			fs.unlinkSync(config.viewers.filePath + i + '.txt');
			i++;
		} else {
			fileFound = false;
		}
	}
	if (fs.existsSync(config.viewers.filePath + '_all.txt')) {
		fs.unlinkSync(config.viewers.filePath + '_all.txt');
	}
	if (callback) {
		callback();
	}
}

function createViewerFiles() {
	for (var i = 0; i < Math.ceil(viewers.length / config.viewers.viewersPerFile) && i < config.viewers.numberOfFiles; i++) {
		fs.writeFile(config.viewers.filePath + i + '.txt', viewers.slice(i * config.viewers.viewersPerFile, (i + 1) * config.viewers.viewersPerFile).join('\r\n'), (err) => {});
	}
	fs.writeFile(config.viewers.filePath + '_all.txt', viewers.slice(0, config.viewers.viewersPerFile * config.viewers.numberOfFiles).join('\r\n'), (err) => {});
}

function osuLogin() {
	mainWindow.webContents.send('osuStatus', 'Connecting');
	osuClient = new irc.Client('irc.ppy.sh', config.osu.username, {
		autoRejoin: true,
		autoConnect: false,
		password: config.osu.password,
		floodProtection: true,
		floodProtectionDelay: 1000
	});
	osuClient.addListener('registered', (message) => {
		mainWindow.webContents.send('osuStatus', 'Connected');
	});
	osuClient.addListener('error', (message) => {
		if (message.command == 'err_passwdmismatch') {
			mainWindow.webContents.send('osuStatus', 'Wrong username or password');
			osuClient.disconnect();
			osuClient = null;
		}
	});
	osuClient.connect();
}

function twitchLogin() {
	if (channel && user) {
		twitchClient = new tmi.client({
			options: {
				debug: true
			},
			connection: {
				reconnect: true
			},
			identity: {
				username: user.name.toLowerCase(),
				password: 'oauth:' + accessToken
			},
			channels: [
				'#' + channel.name.toLowerCase()
			]
		});
		twitchClient.on('connecting', (address, port) => {
			mainWindow.webContents.send('twitchStatus', 'Connecting');
		});
		twitchClient.on('connected', (address, port) => {
			mainWindow.webContents.send('twitchStatus', 'Connected');
		});
		twitchClient.on('disconnected', (reason) => {
			mainWindow.webContents.send('twitchStatus', 'Disconnected');
		});
		twitchClient.on('subscription', (channelName, username, method, message, userstate) => {
			if (config.spam.enabled) {
				twitchMessageQueue.push(config.spam.message.replace(/{user}/g, username));
			}
		});
		twitchClient.on('resub', (channelName, username, months, message, userstate, methods) => {
			if (config.spam.enabled) {
				twitchMessageQueue.push(config.spam.message.replace(/{user}/g, username));
			}
		});
		twitchClient.on('subgift', (channelName, username, method, message, userstate, recipient) => {
			if (config.spam.enabled) {
				twitchMessageQueue.push(config.spam.giftMessage.replace(/{user}/g, username).replace(/{recipient}/g, recipient));
			}
		});
		twitchClient.on('message', (channelName, userstate, message, self) => {
			if (userstate['message-type'] != 'chat') return;
			let username = userstateToName(userstate);
			if (config.viewers.enabled) {
				if (!viewers.includes(username)) {
					viewers.push(username);
					mainWindow.webContents.send('viewers', viewers);
					createViewerFiles();
				}
			}
			if (config.requests.enabled) {
				if (message.includes('osu.ppy.sh')) {
					Promise.all([getBeatmapIdFromMessage(message), getUserSubTier(userstate['user-id'])])
					.then(([beatmapId, subTier]) => {
						if (config.requests.subOnly.enabled && subTier == 'Pleb') {
							if (config.requests.subOnly.twitchResponse.enabled && !subOnlyOnCooldown) {
								let chatMessage = config.requests.subOnly.twitchResponse.message;
								chatMessage = chatMessage.replace(/{requester}/g, username);
								twitchMessageQueue.push(chatMessage);
								subOnlyOnCooldown = true;
								setTimeout(() => {
									subOnlyOnCooldown = false;
								}, 30000);
							}
						} else {
							if (config.requests.cooldown.enabled && requestCooldowns.includes(username)) {
								if (config.requests.cooldown.twitchResponse.enabled) {
									let chatMessage = config.requests.cooldown.twitchResponse.message;
									chatMessage = chatMessage.replace(/{requester}/g, username);
									twitchMessageQueue.push(chatMessage);
								}
							} else {
								let mods = [];
								if (message.includes('HD')) {
									mods.push('HD');
								}
								if (message.includes('HR')) {
									mods.push('HR');
								}
								if (message.includes('DT')) {
									mods.push('DT');
								}

								requestBeatmap(beatmapId, mods, username, subTier);

								if (config.requests.cooldown.enabled && (!config.requests.cooldown.plebOnly || (config.requests.cooldown.plebOnly && subTier == 'Pleb'))) {
									requestCooldowns.push(username);
									setTimeout(() => {
										requestCooldowns.splice(requestCooldowns.indexOf(username), 1);
									}, config.requests.cooldown.seconds * 1000);
								}
							}
						}
					})
					.catch((err) => {
						// no beatmap link found in message
					});
				}
			}
			if (config.levels.enabled) {
				let userObject = levels.find((item) => {
					return item.userId == userstate['user-id'];
				});
				if (!userObject) {
					request('https://mikuia.tv/api/user/' + userstate['username'] + '/levels/' + channel.name.toLowerCase())
					.then((body) => {
						exp = 0;
						level = 0;
						try {
							let levelData = JSON.parse(body);
							if (levelData.experience) {
								exp = levelData.experience;
								level = Math.floor(0.125 * (Math.sqrt(4 * exp + 689) - 25));
							}
						} catch(err) {
							// user or channel probably not found
						}
						levels.push({
							userId: userstate['user-id'],
							username: username,
							exp: exp,
							level: level,
							activity: 5
						});
					})
					.catch((err) => {
						console.error(err);
					});
				} else {
					userObject.activity = 5;
				}
			}
			if (message.startsWith('!rank') && !rankOnCooldown) {
				twitchMessageQueue.push('osu! #' + config.events.rank.current);
				rankOnCooldown = true;
				setTimeout(() => {
					rankOnCooldown = false;
				}, 30000);
			}
		});
		twitchMessageTimer = setInterval(() => {
			if (twitchMessageQueue.length > 0 && twitchClient && twitchClient.readyState() == 'OPEN') {
				twitchClient.action(channel.name.toLowerCase(), twitchMessageQueue.shift())
				.then((data) => {
					// everything is ok
				}).catch((err) => {
					console.log(err);
				});
			}
		}, 500);
		twitchClient.connect();
	}
}

function requestBeatmap(beatmapId, mods, username, subTier) {
	console.log('test');
	if (config.requests.noDuplicates.enabled && requests.some((beatmap) => {
		return beatmap.beatmapId == beatmapId;
	})) {
		if (config.requests.noDuplicates.twitchResponse.enabled) {
			let chatMessage = config.requests.noDuplicates.twitchResponse.message.replace(/{requester}/g, username);
			twitchMessageQueue.push(chatMessage);
		}
	} else {
		Promise.all([request('https://osu.ppy.sh/beatmaps/' + beatmapId), request('https://osu.ppy.sh/osu/' + beatmapId)])
		.then(([mapData, mapFile]) => {
			let $ = cheerio.load(mapData);
			let beatmapset = JSON.parse($('#json-beatmapset').html());
			let beatmapData = beatmapset.beatmaps.find((item) => {
				return item.id == beatmapId;
			});
			fs.writeFile('oppai/' + beatmapId + '.osu', mapFile, (err) => {
				execFile('oppai/oppai', ['oppai/' + beatmapId + '.osu', '+' + mods.join(''), '-ojson'], (err, data) => {
					if (err) {
						throw(err);
					}
					data = JSON.parse(data);
					let beatmap = {
						accuracy: data.od.toFixed(1),
						ar: data.ar,
						artist: beatmapset.artist,
						beatmapId: beatmapId,
						beatmapsetId: beatmapset.id,
						bpm: mods.includes('DT') ? beatmapset.bpm * 1.5 : beatmapset.bpm,
						countCircles: beatmapData.count_circles,
						countSliders: beatmapData.count_sliders,
						cover: beatmapset.covers['cover@2x'],
						cs: data.cs.toFixed(1),
						difficultyRating: data.stars.toFixed(2),
						drain: data.hp.toFixed(1),
						previewUrl: beatmapset.preview_url,
						title: beatmapset.title,
						totalLength: beatmapData.total_length * 2/3,
						status: beatmapset.status,
						version: beatmapData.version,
						mods: mods,
						requester: username,
						subTier: subTier,
						pp: data.pp.toFixed(2)
					}
					mainWindow.webContents.send('newRequest', beatmap);
					requests.push(beatmap);
					let chatMessage = config.requests.twitchResponse.message;
					if (config.requests.twitchResponse.enabled) {
						chatMessage = messageReplace(config.requests.twitchResponse.message, beatmap);
						twitchMessageQueue.push(chatMessage);
					}
					if (config.requests.osuResponse.enabled && osuClient) {
						chatMessage = messageReplace(config.requests.osuResponse.message, beatmap);
						osuClient.say(config.osu.username, chatMessage);
					}
				});
			});
		})
		.catch((err) => {
			console.error(err);
		});
	}
}

function messageReplace(message, values) {
	message = message.replace(/{accuracy}/g, values.accuracy);
	message = message.replace(/{artist}/g, values.artist);
	message = message.replace(/{ar}/g, values.ar);
	message = message.replace(/{beatmapId}/g, values.beatmapId);
	message = message.replace(/{beatmapsetId}/g, values.beatmapsetId);
	message = message.replace(/{bpm}/g, values.bpm);
	message = message.replace(/{countCircles}/g, values.countCircles);
	message = message.replace(/{countSliders}/g, values.countSliders);
	message = message.replace(/{cover}/g, values.cover);
	message = message.replace(/{cs}/g, values.cs);
	message = message.replace(/{difficultyRating}/g, values.difficultyRating);
	message = message.replace(/{drain}/g, values.drain);
	message = message.replace(/{mods}/g, values.mods.join(''));
	message = message.replace(/{pp}/g, values.pp);
	message = message.replace(/{previewUrl}/g, values.previewUrl);
	message = message.replace(/{requester}/g, values.requester);
	message = message.replace(/{status}/g, values.status);
	message = message.replace(/{subTier}/g, values.subTier);
	message = message.replace(/{title}/g, values.title);
	message = message.replace(/{totalLength}/g, '' + Math.floor(values.totalLength / 60) + ':' + ('00' + values.totalLength % 60).slice(-2));
	message = message.replace(/{version}/g, values.version);
	return message;
}

function userstateToName(userstate) {
	if (userstate['display-name']) {
		return userstate['display-name'];
	}
	return userstate['username'];
}

function loadConfig() {
	if (!fs.existsSync(app.getPath('userData') + '\\config.json')) {
		config = {
			osu: {
				username: '',
				password: ''
			},
			viewers: {
				enabled: true,
				filePath: 'viewers',
				viewersPerFile: 6,
				numberOfFiles: 4
			},
			requests: {
				enabled: true,
				subOnly: {
					enabled: true,
					twitchResponse: {
						enabled: true,
						message: '{requester} beatmap requests are sub only ;)'
					}
				},
				twitchResponse: {
					enabled: true,
					message: '[{status}] {artist} - {title} [{version}] {mods}, {bpm} BPM, {difficultyRating} stars, {pp} pp'
				},
				osuResponse: {
					enabled: true,
					message: '{requester} ({subTier}) > [https://osu.ppy.sh/b/{beatmapId} {artist} - {title} [{version}]]'
				},
				cooldown: {
					enabled: true,
					plebOnly: true,
					seconds: 60,
					twitchResponse: {
						enabled: false,
						message: '{requester} you recently requested a map. Please wait until you request again'
					}
				},
				noDuplicates: {
					enabled: true,
					twitchResponse: {
						enabled: true,
						message: '{requester} this map already got requested'
					}
				}
			},
			spam: {
				enabled: true,
				message: '{user} stickGold {user} stickGold {user} stickGold {user} stickGold {user} stickGold {user} stickGold',
				giftMessage: '{user} gifted {recipient} a sub'
			},
			events: {
				rank: {
					enabled: true,
					message: 'Rank: #{rank} ({rankChange})',
					current: 0
				},
				pp: {
					enabled: true,
					message: '{ppChange}pp',
					current: 0
				},
				topRanks: {
					enabled: true,
					message: '{username} achieved rank #{rank} on {beatmap}',
					last: 0
				}
			},
			levels: {
				enabled: true,
				message: '{username} just advanced to {channel} Level {level}'
			},
			np: {
				enabled: true,
				filePath: 'np'
			}
		}
		saveConfig();
	} else {
		config = require(app.getPath('userData') + '\\config.json');
		if (!config.hasOwnProperty('events')) {
			config.events = {
				rank: {
					enabled: true,
					message: 'Rank: #{rank} ({rankChange})',
					current: 0
				},
				pp: {
					enabled: true,
					message: '{ppChange}pp',
					current: 0
				},
				topRanks: {
					enabled: true,
					message: '{username} achieved rank #{rank} on {beatmap}',
					last: 0
				}
			}
		}
		if (!config.hasOwnProperty('levels')) {
			config.levels = {
				enabled: true,
				message: '{username} just advanced to {channel} Level {level}'
			}
		}
		if (!config.hasOwnProperty('np')) {
			config.np = {
				enabled: true,
				filePath: 'np'
			}
		}
		if (!config.viewers.hasOwnProperty('numberOfFiles')) {
			config.viewers.numberOfFiles = 4
		}
		if (!config.requests.hasOwnProperty('noDuplicates')) {
			config.requests.noDuplicates = {
				enabled: true,
				twitchResponse: {
					enabled: true,
					message: '{requester} this map already got requested'
				}
			}
		}
		if (!config.spam.hasOwnProperty('giftMessage')) {
			config.spam.giftMessage = '{user} gifted {recipient} a sub';
		}
		saveConfig();
	}
	mainWindow.webContents.send('config', config);
	if (config.osu.username && config.osu.password) {
		osuLogin();
	}
	viewers = [];
	requests = [];
	requestCooldowns = [];
	deleteViewerFiles();

	eventTimer = setInterval(() => {
		if (config.osu.username) {
			if (config.events.rank.enabled || config.events.pp.enabled || config.events.topRanks.enabled) {
				request('https://osu.ppy.sh/users/' + config.osu.username)
				.then((body) => {
					let $ = cheerio.load(body);
					let userData = JSON.parse($('#json-user').html());
					let statisticsData = JSON.parse($('#json-statistics').html());
					if (config.events.rank.enabled && statisticsData.pp_rank != config.events.rank.current) {
						let chatMessage = config.events.rank.message;
						chatMessage = chatMessage.replace(/{rank}/g, statisticsData.pp_rank);
						if (config.events.rank.current < statisticsData.pp_rank) {
							chatMessage = chatMessage.replace(/{rankChange}/g, '-' + (Number(statisticsData.pp_rank) - Number(config.events.rank.current)));
						} else {
							chatMessage = chatMessage.replace(/{rankChange}/g, '+' + (Number(config.events.rank.current) - Number(statisticsData.pp_rank)));
						}
						twitchMessageQueue.push(chatMessage);
						config.events.rank.current = statisticsData.pp_rank;
					}
					if (config.events.pp.enabled && statisticsData.pp != config.events.pp.current) {
						let chatMessage = config.events.pp.message;
						if (config.events.pp.current < statisticsData.pp) {
							chatMessage = chatMessage.replace(/{ppChange}/g, '+' + (Number(statisticsData.pp) - Number(config.events.pp.current)).toFixed(2));
						} else {
							chatMessage = chatMessage.replace(/{ppChange}/g, '-' + (Number(config.events.pp.current) - Number(statisticsData.pp)).toFixed(2));
						}
						twitchMessageQueue.push(chatMessage);
						config.events.pp.current = statisticsData.pp;
					}
					if (config.events.topRanks.enabled && userData.recentActivities[0].id != config.events.topRanks.last) {
						let chatMessage = config.events.topRanks.message;
						chatMessage = chatMessage.replace(/{username}/g, config.osu.username);
						chatMessage = chatMessage.replace(/{rank}/g, userData.recentActivities[0].rank);
						chatMessage = chatMessage.replace(/{beatmap}/g, userData.recentActivities[0].beatmap.title);
						twitchMessageQueue.push(chatMessage);
						config.events.topRanks.last = userData.recentActivities[0].id;
					}
					saveConfig();
				})
				.catch((err) => {
					console.error(err);
				});
			}
		}
	}, 60000);

	npTimer = setInterval(() => {
		if (config.np.enabled) {
			execFile('tasklist', ['/v', '/fo "list"', '/fi "ImageName eq osu!.exe"'], {windowsVerbatimArguments: true}, (err, data) => {
				if (err) {
					throw(err);
				}
				let result = data.split('\r\n');
				result.forEach((item) => {
					if (item.startsWith('Window Title:')) {
						let title = item.split(' - ');
						title.shift();
						title = title.join(' - ');
						fs.writeFile(config.np.filePath + '.txt', title, (err) => {});
					}
				});
			});
		} else {
			fs.writeFile(config.np.filePath + '.txt', '', (err) => {});
		}
	}, 10000);
}

function saveConfig() {
	fs.writeFile(app.getPath('userData') + '\\config.json', JSON.stringify(config, null, 2), (err) => {});
}

function loadLevels() {
	if (!fs.existsSync(app.getPath('userData') + '\\levels.json')) {
		levels = [];
	} else {
		levels = require(app.getPath('userData') + '\\levels.json');
	}
	levelsTimer = setInterval(() => {
		levels.forEach((item) => {
			if (item.activity > 0) {
				item.exp += item.activity;
				item.activity--;
				currentLevel = Math.floor(0.125 * (Math.sqrt(4 * item.exp + 689) - 25));
				if (currentLevel > item.level) {
					item.level = currentLevel;
					let chatMessage = config.levels.message;
					chatMessage = chatMessage.replace(/{username}/g, item.username);
					chatMessage = chatMessage.replace(/{channel}/g, channel.display_name);
					chatMessage = chatMessage.replace(/{level}/g, item.level);
					twitchMessageQueue.push(chatMessage);
				}
			}
		});
		saveLevels();
	}, 60000);
}

function saveLevels() {
	levels = levels.filter((item, index, array) => {
		return index == array.findIndex((item2) => {
			return item2.userId == item.userId;
		});
	});
	fs.writeFile(app.getPath('userData') + '\\levels.json', JSON.stringify(levels, null, 2), (err) => {});
}

function getUserSubTier(userId) {
	request({
		url: 'https://api.twitch.tv/kraken/channels/' + channel._id + '/subscriptions/' + userId,
		headers: {
			'Accept': 'application/vnd.twitchtv.v5+json',
			'Client-ID': clientId,
			'Authorization': 'OAuth ' + accessToken
		},
		gzip: true
	})
	.then((body) => {
		let subTier = 'Pleb';
		let subscription = JSON.parse(body);
		if (subscription && subscription['_id']) {
			switch (subscription.sub_plan) {
				case '1000': subTier = 'Tier 1'; break;
				case '2000': subTier = 'Tier 2'; break;
				case '3000': subTier = 'Tier 3'; break;
				default: subTier = '?';
			}
		}
		return Promise.resolve(subTier);
	})
	.catch((err) => {
		return Promise.resolve('Pleb');
	});
}

function getBeatmapIdFromMessage(message) {
	let regexp = new RegExp('https?://osu.ppy.sh/b/[0-9]+.*');
	let match;
	if (regexp.test(message)) {
		regexp = /b\/[0-9]+/g
		match = regexp.exec(message);
		return Promise.resolve(match[0].substring(2));
	}

	regexp = new RegExp('https?://osu.ppy.sh/beatmapsets/[0-9]+#osu/[0-9]+.*');
	if (regexp.test(message)) {
		regexp = /#osu\/[0-9]+/g
		match = regexp.exec(message);
		return Promise.resolve(match[0].substring(5));
	}

	regexp = new RegExp('https?://osu.ppy.sh/s/[0-9]+.*');
	if (!regexp.test(message)) {
		return Promise.reject('No beatmap link found');
	}
	regexp = /s\/[0-9]+/g
	match = regexp.exec(message);
	let beatmapsetId = match[0].substring(2);

	return request('https://osu.ppy.sh/beatmapsets/' + beatmapsetId)
	.then((body) => {
		let $ = cheerio.load(body);
		let beatmapset = JSON.parse($('#json-beatmapset').html());
		let highestStar = 0;
		let beatmapId;
		for (var i = 0; i < beatmapset.beatmaps.length; i++) {
			if (beatmapset.beatmaps[i].difficulty_rating > highestStar) {
				beatmapId = beatmapset.beatmaps[i].id;
				highestStar = beatmapset.beatmaps[i].difficulty_rating;
			}
		}
		return Promise.resolve(beatmapId);
	})
	.catch((err) => {
		console.error(err);
	});
}

ipcMain.on('osuLogin', (event, args) => {
	config.osu = args;
	saveConfig();
	osuLogin();
});

ipcMain.on('osuLogout', (event, args) => {
	osuClient.disconnect();
	mainWindow.webContents.send('osuStatus', 'Disconnected');
});

ipcMain.on('viewersConfig', (event, args) => {
	config.viewers = args;
	saveConfig();
	deleteViewerFiles(() => {
		createViewerFiles();
	});
});

ipcMain.on('spamConfig', (event, args) => {
	config.spam = args;
	saveConfig();
});

ipcMain.on('requestsConfig', (event, args) => {
	config.requests = args;
	saveConfig();
});

ipcMain.on('eventsConfig', (event, args) => {
	config.events.rank.enabled = args.rank.enabled;
	config.events.rank.message = args.rank.message;
	config.events.pp.enabled = args.pp.enabled;
	config.events.pp.message = args.pp.message;
	config.events.topRanks.enabled = args.topRanks.enabled;
	config.events.topRanks.message = args.topRanks.message;
	saveConfig();
});

ipcMain.on('levelsConfig', (event, args) => {
	config.levels = args;
	saveConfig();
});

ipcMain.on('npConfig', (event, args) => {
	config.np = args;
	saveConfig();
});

ipcMain.on('resetViewers', (event, args) => {
	viewers = [];
	deleteViewerFiles();
});

app.on('ready', createWindow);

app.on('window-all-closed', () => {
	app.quit();
});