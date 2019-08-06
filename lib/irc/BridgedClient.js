/*eslint no-invalid-this: 0 */
"use strict";

const Promise = require("bluebird");
const promiseutil = require("../promiseutil");
const util = require("util");
const EventEmitter = require("events").EventEmitter;
const ident = require("./ident");
const ConnectionInstance = require("./ConnectionInstance");
const IrcRoom = require("../models/IrcRoom");
const log = require("../logging").get("BridgedClient");

// The length of time to wait before trying to join the channel again
const JOIN_TIMEOUT_MS = 15 * 1000; // 15s
const NICK_DELAY_TIMER_MS = 10 * 1000; // 10s

/**
 * Create a new bridged IRC client.
 * @constructor
 * @param {IrcServer} server
 * @param {IrcClientConfig} ircClientConfig : The IRC user to create a connection for.
 * @param {MatrixUser} matrixUser : Optional. The matrix user representing this virtual IRC user.
 * @param {boolean} isBot : True if this is the bot
 * @param {IrcEventBroker} eventBroker
 * @param {IdentGenerator} identGenerator
 * @param {Ipv6Generator} ipv6Generator
 */
function BridgedClient(server, ircClientConfig, matrixUser, isBot, eventBroker, identGenerator,
                       ipv6Generator) {
    this._eventBroker = eventBroker;
    this._identGenerator = identGenerator;
    this._ipv6Generator = ipv6Generator;
    this._clientConfig = ircClientConfig;
    this.matrixUser = matrixUser;
    this.server = server;
    this.userId = matrixUser ? this.matrixUser.getId() : null;
    this.displayName = matrixUser ? this.matrixUser.getDisplayName() : null;
    this.nick = this._getValidNick(
        ircClientConfig.getDesiredNick() || server.getNick(this.userId, this.displayName),
        false);
    this.password = (
        ircClientConfig.getPassword() ? ircClientConfig.getPassword() : server.config.password
    );

    this.isBot = Boolean(isBot);
    this.lastActionTs = Date.now();
    this.inst = null;
    this.instCreationFailed = false;
    this.explicitDisconnect = false;
    this.disconnectReason = null;
    this.chanList = [];
    this._connectDefer = promiseutil.defer();
    this._id = (Math.random() * 1e20).toString(36);
    // decorate log lines with the nick and domain, along with an instance id
    var prefix = "<" + this.nick + "@" + this.server.domain + "#" + this._id + "> ";
    if (this.userId) {
        prefix += "(" + this.userId + ") ";
    }
    this.log = {
        debug: function() {
            arguments[0] = prefix + arguments[0];
            log.debug.apply(log, arguments);
        },
        info: function() {
            arguments[0] = prefix + arguments[0];
            log.info.apply(log, arguments);
        },
        error: function() {
            arguments[0] = prefix + arguments[0];
            log.error.apply(log, arguments);
        }
    };

    this._cachedOperatorNicksInfo = {
        // $channel : info
    };
}
util.inherits(BridgedClient, EventEmitter);

BridgedClient.prototype.getClientConfig = function() {
    return this._clientConfig;
};

BridgedClient.prototype.kill = function(reason) {
    // Nullify so that no further commands can be issued
    //  via unsafeClient, which should be null checked
    //  anyway as it is not instantiated until a connection
    //  has occurred.
    this.unsafeClient = null;
    // kill connection instance
    log.info('Killing client ', this.nick);
    return this.disconnect(reason || "Bridged client killed");
}

BridgedClient.prototype.isDead = function() {
    if (this.instCreationFailed || (this.inst && this.inst.dead)) {
        return true;
    }
    return false;
};

BridgedClient.prototype.toString = function() {
    let domain = this.server ? this.server.domain : "NO_DOMAIN";
    return `${this.nick}@${domain}#${this._id}~${this.userId}`;
};

/**
 * @return {ConnectionInstance} A new connected connection instance.
 */
BridgedClient.prototype.connect = Promise.coroutine(function*() {
    var server = this.server;
    try {
        let nameInfo = yield this._identGenerator.getIrcNames(
            this._clientConfig, this.matrixUser
        );
        if (this.server.getIpv6Prefix()) {
            // side-effects setting the IPv6 address on the client config
            yield this._ipv6Generator.generate(
                this.server.getIpv6Prefix(), this._clientConfig
            );
        }
        this.log.info(
            "Connecting to IRC server %s as %s (user=%s)",
            server.domain, this.nick, nameInfo.username
        );
        this._eventBroker.sendMetadata(this,
            `Connecting to the IRC network '${this.server.domain}' as ${this.nick}...`
        );

        let connInst = yield ConnectionInstance.create(server, {
            nick: this.nick,
            username: nameInfo.username,
            realname: nameInfo.realname,
            password: this.password,
            // Don't use stored IPv6 addresses unless they have a prefix else they
            // won't be able to turn off IPv6!
            localAddress: (
                this.server.getIpv6Prefix() ? this._clientConfig.getIpv6Address() : undefined
            )
        }, (inst) => {
            this._onConnectionCreated(inst, nameInfo);
        });

        this.inst = connInst;
        this.unsafeClient = connInst.client;
        this.emit("client-connected", this);
        // we may have been assigned a different nick, so update it from source
        this.nick = connInst.client.nick;
        this._connectDefer.resolve();
        this._keepAlive();

        let connectText = (
            `You've been connected to the IRC network '${this.server.domain}' as ${this.nick}.`
        );

        let userModes = this.server.getUserModes();
        if (userModes.length > 0 && !this.isBot) {
            // These can fail, but the generic error listener will catch them and send them
            // into the same room as the connect text, so it's probably good enough to not
            // explicitly handle them.
            this.unsafeClient.setUserMode("+" + userModes);
            connectText += (
                ` User modes +${userModes} have been set.`
            );
        }

        this._eventBroker.sendMetadata(this, connectText);

        connInst.client.addListener("nick", (old, newNick) => {
            if (old === this.nick) {
                this.log.info(
                    "NICK: Nick changed from '" + old + "' to '" + newNick + "'."
                );
                this.nick = newNick;
                this.emit("nick-change", this, old, newNick);
            }
        });
        connInst.client.addListener("error", (err) => {
            // Errors we MUST notify the user about, regardless of the bridge's admin room config.
            const ERRORS_TO_FORCE = ["err_nononreg"]
            if (!err || !err.command || connInst.dead) {
                return;
            }
            var msg = "Received an error on " + this.server.domain + ": " + err.command + "\n";
            msg += JSON.stringify(err.args);
            this._eventBroker.sendMetadata(this, msg, ERRORS_TO_FORCE.includes(err.command));
        });
        return connInst;
    }
    catch (err) {
        this.log.debug("Failed to connect.");
        this.instCreationFailed = true;
        throw err;
    }
});

BridgedClient.prototype.disconnect = function(reason) {
    this.explicitDisconnect = true;
    if (!this.inst || this.inst.dead) {
        return Promise.resolve();
    }
    return this.inst.disconnect(reason);
};

/**
 * Change this user's nick.
 * @param {string} newNick The new nick for the user.
 * @param {boolean} throwOnInvalid True to throw an error on invalid nicks
 * instead of coercing them.
 * @return {Promise<String>} Which resolves to a message to be sent to the user.
 */
BridgedClient.prototype.changeNick = function(newNick, throwOnInvalid) {
    let validNick = newNick;
    try {
        validNick = this._getValidNick(newNick, throwOnInvalid);
        if (validNick === this.nick) {
            return Promise.resolve(`Your nick is already '${validNick}'.`);
        }
    }
    catch (err) {
        return Promise.reject(err);
    }
    if (!this.unsafeClient) {
        return Promise.reject(new Error("You are not connected to the network."));
    }

    return new Promise((resolve, reject) => {
        var nickListener, nickErrListener;
        var timeoutId = setTimeout(() => {
            this.log.error("Timed out trying to change nick to %s", validNick);
            // may have d/ced between sending nick change and now so recheck
            if (this.unsafeClient) {
                this.unsafeClient.removeListener("nick", nickListener);
                this.unsafeClient.removeListener("error", nickErrListener);
            }
            reject(new Error("Timed out waiting for a response to change nick."));
        }, NICK_DELAY_TIMER_MS);
        nickListener = (old, n) => {
            clearTimeout(timeoutId);
            this.unsafeClient.removeListener("error", nickErrListener);
            resolve("Nick changed from '" + old + "' to '" + n + "'.");
        };
        nickErrListener = (err) => {
            if (!err || !err.command) { return; }
            var failCodes = [
                "err_banonchan", "err_nickcollision", "err_nicknameinuse",
                "err_erroneusnickname", "err_nonicknamegiven", "err_eventnickchange",
                "err_nicktoofast", "err_unavailresource"
            ];
            if (failCodes.indexOf(err.command) !== -1) {
                this.log.error("Nick change error : %s", err.command);
                clearTimeout(timeoutId);
                this.unsafeClient.removeListener("nick", nickListener);
                reject(new Error("Failed to change nick: " + err.command));
            }
        };
        this.unsafeClient.once("nick", nickListener);
        this.unsafeClient.once("error", nickErrListener);
        this.unsafeClient.send("NICK", validNick);
    });
};

BridgedClient.prototype.joinChannel = function(channel, key) {
    return this._joinChannel(channel, key);
};

BridgedClient.prototype.leaveChannel = function(channel, reason) {
    return this._leaveChannel(channel, reason);
};

BridgedClient.prototype._leaveChannel = function(channel, reason) {
    reason = reason || "User left";
    if (!this.inst || this.inst.dead) {
        return Promise.resolve(); // we were never connected to the network.
    }
    if (channel.indexOf("#") !== 0) {
        return Promise.resolve(); // PM room
    }
    if (!this.inChannel(channel)) {
        return Promise.resolve(); // we were never joined to it.
    }
    var self = this;
    var defer = promiseutil.defer();
    this._removeChannel(channel);
    self.log.debug("Leaving channel %s", channel);
    this.unsafeClient.part(channel, reason, function() {
        self.log.debug("Left channel %s", channel);
        defer.resolve();
    });

    return defer.promise;
};

BridgedClient.prototype.inChannel = function(channel) {
    return this.chanList.includes(channel);
}

BridgedClient.prototype.kick = function(nick, channel, reason) {
    reason = reason || "User kicked";
    if (!this.inst || this.inst.dead) {
        return Promise.resolve(); // we were never connected to the network.
    }
    if (Object.keys(this.unsafeClient.chans).indexOf(channel) === -1) {
        // we were never joined to it. We need to be joined to it to kick people.
        return Promise.resolve();
    }
    if (channel.indexOf("#") !== 0) {
        return Promise.resolve(); // PM room
    }

    return new Promise((resolve, reject) => {
        this.log.debug("Kicking %s from channel %s", nick, channel);
        this.unsafeClient.send("KICK", channel, nick, reason);
        resolve(); // wait for some response? Is there even one?
    });
};

BridgedClient.prototype.sendAction = function(room, action) {
    this._keepAlive();
    let expiryTs = 0;
    if (action.ts && this.server.getExpiryTimeSeconds()) {
        expiryTs = action.ts + (this.server.getExpiryTimeSeconds() * 1000);
    }
    switch (action.type) {
        case "message":
            return this._sendMessage(room, "message", action.text, expiryTs);
        case "notice":
            return this._sendMessage(room, "notice", action.text, expiryTs);
        case "emote":
            return this._sendMessage(room, "action", action.text, expiryTs);
        case "topic":
            return this._setTopic(room, action.text);
        default:
            this.log.error("Unknown action type: %s", action.type);
    }
    return Promise.reject(new Error("Unknown action type: " + action.type));
};

/**
 * Get the whois info for an IRC user
 * @param {string} nick : The nick to call /whois on
 */
BridgedClient.prototype.whois = function(nick) {
    var self = this;
    return new Promise(function(resolve, reject) {
        self.unsafeClient.whois(nick, function(whois) {
            if (!whois.user) {
                reject(new Error("Cannot find nick on whois."));
                return;
            }
            let idle = whois.idle ? `${whois.idle} seconds idle` : "";
            let chans = (
                (whois.channels && whois.channels.length) > 0 ?
                `On channels: ${JSON.stringify(whois.channels)}` :
                ""
            );

            let info = `${whois.user}@${whois.host}
            Real name: ${whois.realname}
            ${chans}
            ${idle}
            `;
            resolve({
                server: self.server,
                nick: nick,
                msg: `Whois info for '${nick}': ${info}`
            });
        });
    });
};


/**
 * Get the operators of a channel (including users more powerful than operators)
 * @param {string} channel : The channel to call /names on
 * @param {object} opts: Optional. An object containing the following key-value pairs:
 *     @param {string} key : Optional. The key to use to join the channel.
 *     @param {integer} cacheDurationMs : Optional. The duration of time to keep a
 *         list of operator nicks cached. If > 0, the operator nicks will be returned
 *         whilst the cache is still valid and it will become invalid after cacheDurationMs
 *         milliseconds. Cache will not be used if left undefined.
 */
BridgedClient.prototype.getOperators = function(channel, opts) {
    let key = opts.key;
    let cacheDurationMs = opts.cacheDurationMs;

    if (typeof key !== 'undefined' && typeof key !== 'string') {
        throw new Error('key must be a string');
    }

    if (typeof cacheDurationMs !== 'undefined') {
        if (!(Number.isInteger(cacheDurationMs) && cacheDurationMs > 0)) {
            throw new Error('cacheDurationMs must be a positive integer');
        }
        // If cached previously, use cache
        if (typeof this._cachedOperatorNicksInfo[channel] !== 'undefined') {
            return Promise.resolve(this._cachedOperatorNicksInfo[channel]);
        }
    }

    return this._joinChannel(channel, key).then(() => {
        return this.getNicks(channel);
    }).then((nicksInfo) => {
        return this._leaveChannel(channel).then(() => nicksInfo);
    }).then((nicksInfo) => {
        let nicks = nicksInfo.nicks;
        // RFC 1459 1.3.1:
        // A channel operator is identified by the '@' symbol next to their
        // nickname whenever it is associated with a channel (ie replies to the
        // NAMES, WHO and WHOIS commands).

        // http://www.irc.org/tech_docs/005.html
        // ISUPPORT PREFIX:
        // A list of channel modes a person can get and the respective prefix a channel
        // or nickname will get in case the person has it. The order of the modes goes
        // from most powerful to least powerful. Those prefixes are shown in the output
        // of the WHOIS, WHO and NAMES command.
        // Note: Some servers only show the most powerful, others may show all of them.

        // Ergo: They are a chan op if they are "@" or "more powerful than @".
        nicksInfo.operatorNicks = nicks.filter((nick) => {
            for (let i = 0; i < nicksInfo.names[nick].length; i++) {
                let prefix = nicksInfo.names[nick][i];
                if (prefix === "@") {
                    return true;
                }
                let cli = this.unsafeClient;
                if (!cli) {
                    throw new Error("Missing client");
                }
                if (cli.isUserPrefixMorePowerfulThan(prefix, "@")) {
                    return true;
                }
            }
            return false;
        });

        if (typeof cacheDurationMs !== 'undefined') {
            this._cachedOperatorNicksInfo[channel] = nicksInfo;
            setTimeout(()=>{
                //Invalidate the cache
                delete this._cachedOperatorNicksInfo[channel];
            }, cacheDurationMs);
        }

        return nicksInfo;
    });
};

/**
 * Get the nicks of the users in a channel
 * @param {string} channel : The channel to call /names on
 */
BridgedClient.prototype.getNicks = function(channel) {
    var self = this;
    return new Promise(function(resolve, reject) {
        self.unsafeClient.names(channel, function(channelName, names) {
            // names maps nicks to chan op status, where '@' indicates chan op
            // names = {'nick1' : '', 'nick2' : '@', ...}
            resolve({
                server: self.server,
                channel: channelName,
                nicks: Object.keys(names),
                names: names,
            });
        });
    }).timeout(5000);
};


/**
 * Convert the given nick into a valid nick. This involves length and character
 * checks on the provided nick. If the client is connected to an IRCd then the
 * cmds received (e.g. NICKLEN) will be used in the calculations. If the client
 * is NOT connected to an IRCd then this function will NOT take length checks
 * into account. This means this function will optimistically allow long nicks
 * in the hopes that it will succeed, rather than use the RFC stated maximum of
 * 9 characters which is far too small. In testing, IRCds coerce long
 * nicks up to the limit rather than preventing the connection entirely.
 *
 * This function may modify the nick in interesting ways in order to coerce the
 * given nick into a valid nick. If throwOnInvalid is true, this function will
 * throw a human-readable error instead of coercing the nick on invalid nicks.
 *
 * @param {string} nick The nick to convert into a valid nick.
 * @param {boolean} throwOnInvalid True to throw an error on invalid nicks
 * instead of coercing them.
 * @return {string} A valid nick.
 * @throws Only if throwOnInvalid is true and the nick is not a valid nick.
 * The error message will contain a human-readable message which can be sent
 * back to a user.
 */
BridgedClient.prototype._getValidNick = function(nick, throwOnInvalid) {
    // Apply a series of transformations to the nick, and check after each
    // stage for mismatches to the input (and throw if appropriate).


    // strip illegal chars according to RFC 2812 Sect 2.3.1
    let n = nick.replace(BridgedClient.illegalCharactersRegex, "");
    if (throwOnInvalid && n !== nick) {
        throw new Error(`Nick '${nick}' contains illegal characters.`);
    }

    // nicks must start with a letter
    if (!/^[A-Za-z]/.test(n)) {
        if (throwOnInvalid) {
            throw new Error(`Nick '${nick}' must start with a letter.`);
        }
        // Add arbitrary letter prefix. This is important for guest user
        // IDs which are all numbers.
        n = "M" + n;
    }

    if (this.unsafeClient) {
        // nicks can't be too long
        let maxNickLen = 9; // RFC 1459 default
        if (this.unsafeClient.supported &&
                typeof this.unsafeClient.supported.nicklength == "number") {
            maxNickLen = this.unsafeClient.supported.nicklength;
        }
        if (n.length > maxNickLen) {
            if (throwOnInvalid) {
                throw new Error(`Nick '${nick}' is too long. (Max: ${maxNickLen})`);
            }
            n = n.substr(0, maxNickLen);
        }
    }

    return n;
}

BridgedClient.prototype._keepAlive = function() {
    this.lastActionTs = Date.now();
    var idleTimeout = this.server.getIdleTimeout();
    if (idleTimeout > 0) {
        if (this._idleTimeout) {
            // stop the timeout
            clearTimeout(this._idleTimeout);
        }
        this.log.debug(
            "_keepAlive; Restarting %ss idle timeout", idleTimeout
        );
        // restart the timeout
        var self = this;
        this._idleTimeout = setTimeout(function() {
            self.log.info("Idle timeout has expired");
            if (self.server.shouldSyncMembershipToIrc("initial")) {
                self.log.info(
                    "Not disconnecting because %s is mirroring matrix membership lists",
                    self.server.domain
                );
                return;
            }
            if (self.isBot) {
                self.log.info("Not disconnecting because this is the bot");
                return;
            }
            self.disconnect(
                "Idle timeout reached: " + idleTimeout + "s"
            ).done(function() {
                self.log.info("Idle timeout reached: Disconnected");
            }, function(e) {
                self.log.error("Error when disconnecting: %s", JSON.stringify(e));
            });
        }, (1000 * idleTimeout));
    }
};
BridgedClient.prototype._removeChannel = function(channel) {
    var i = this.chanList.indexOf(channel);
    if (i === -1) {
        return;
    }
    this.chanList.splice(i, 1);
};
BridgedClient.prototype._addChannel = function(channel) {
    var i = this.chanList.indexOf(channel);
    if (i !== -1) {
        return; // already added
    }
    this.chanList.push(channel);
};
BridgedClient.prototype.getLastActionTs = function() {
    return this.lastActionTs;
};
BridgedClient.prototype._onConnectionCreated = function(connInst, nameInfo) {
    // listen for a connect event which is done when the TCP connection is
    // established and set ident info (this is different to the connect() callback
    // in node-irc which actually fires on a registered event..)
    connInst.client.once("connect", function() {
        var localPort = -1;
        if (connInst.client.conn && connInst.client.conn.localPort) {
            localPort = connInst.client.conn.localPort;
        }
        if (localPort > 0) {
            ident.setMapping(nameInfo.username, localPort);
        }
    });

    connInst.onDisconnect = (reason) => {
        this.disconnectReason = reason;
        if (reason === "banned") {
            // If we've been banned, this is intentional.
            this.explicitDisconnect = true;
        }
        this.emit("client-disconnected", this);
        this._eventBroker.sendMetadata(this,
            "Your connection to the IRC network '" + this.server.domain +
            "' has been lost. "
        );
        clearTimeout(this._idleTimeout);
    };

    this._eventBroker.addHooks(this, connInst);
};

BridgedClient.prototype._setTopic = function(room, topic) {
    // join the room if we haven't already
    return this._joinChannel(room.channel).then(() => {
        this.log.info("Setting topic to %s in channel %s", topic, room.channel);
        this.unsafeClient.send("TOPIC", room.channel, topic);
    });
}

BridgedClient.prototype._sendMessage = function(room, msgType, text, expiryTs) {
    // join the room if we haven't already
    var defer = promiseutil.defer();
    msgType = msgType || "message";
    this._connectDefer.promise.then(() => {
        return this._joinChannel(room.channel);
    }).done(() => {
        // re-check timestamp to see if we should send it now
        if (expiryTs && Date.now() > expiryTs) {
            this.log.error(`Dropping event: too old (expired at ${expiryTs})`);
            defer.resolve();
            return;
        }

        if (msgType == "action") {
            this.unsafeClient.action(room.channel, text);
        }
        else if (msgType == "notice") {
            this.unsafeClient.notice(room.channel, text);
        }
        else if (msgType == "message") {
            this.unsafeClient.say(room.channel, text);
        }
        defer.resolve();
    }, (e) => {
        this.log.error("sendMessage: Failed to join channel " + room.channel);
        defer.reject(e);
    });
    return defer.promise;
}

BridgedClient.prototype._joinChannel = function(channel, key, attemptCount) {
    attemptCount = attemptCount || 1;
    if (!this.unsafeClient) {
        // we may be trying to join before we've connected, so check and wait
        if (this._connectDefer && this._connectDefer.promise.isPending()) {
            return this._connectDefer.promise.then(() => {
                return this._joinChannel(channel, key, attemptCount);
            });
        }
        return Promise.reject(new Error("No client"));
    }
    if (Object.keys(this.unsafeClient.chans).indexOf(channel) !== -1) {
        return Promise.resolve(new IrcRoom(this.server, channel));
    }
    if (!/[#!&+]/.test(channel)) {
        // Private room instead of channel
        return Promise.resolve(new IrcRoom(this.server, channel));
    }
    if (this.server.isExcludedChannel(channel)) {
        return Promise.reject(new Error(channel + " is a do-not-track channel."));
    }
    var defer = promiseutil.defer();
    this.log.debug("Joining channel %s", channel);
    this._addChannel(channel);
    var client = this.unsafeClient;
    // listen for failures to join a channel (e.g. +i, +k)
    var failFn = (err) => {
        if (!err || !err.args) { return; }
        var failCodes = [
            "err_nosuchchannel", "err_toomanychannels", "err_channelisfull",
            "err_inviteonlychan", "err_bannedfromchan", "err_badchannelkey",
            "err_needreggednick"
        ];
        this.log.error("Join channel %s : %s", channel, JSON.stringify(err));
        if (failCodes.indexOf(err.command) !== -1 &&
                err.args.indexOf(channel) !== -1) {
            this.log.error("Cannot track channel %s: %s", channel, err.command);
            client.removeListener("error", failFn);
            defer.reject(new Error(err.command));
            this.emit("join-error", this, channel, err.command);
            this._eventBroker.sendMetadata(
                this, `Could not join ${channel} on '${this.server.domain}': ${err.command}`, true
            );
        }
    };
    client.once("error", failFn);

    // add a timeout to try joining again
    setTimeout(() => {
        if (!this.unsafeClient) {
            log.error(
                `Could not try to join: no client for ${this.nick}, channel = ${channel}`
            );
            return;
        }
        // promise isn't resolved yet and we still want to join this channel
        if (defer.promise.isPending() && this.chanList.indexOf(channel) !== -1) {
            // we may have joined but didn't get the callback so check the client
            if (Object.keys(this.unsafeClient.chans).indexOf(channel) !== -1) {
                // we're joined
                this.log.debug("Timed out joining %s - didn't get callback but " +
                    "are now joined. Resolving.", channel);
                defer.resolve(new IrcRoom(this.server, channel));
                return;
            }
            if (attemptCount >= 5) {
                defer.reject(
                    new Error("Failed to join " + channel + " after multiple tries")
                );
                return;
            }

            this.log.error("Timed out trying to join %s - trying again.", channel);
            // try joining again.
            attemptCount += 1;
            this._joinChannel(channel, key, attemptCount).done(function(s) {
                defer.resolve(s);
            }, function(e) {
                defer.reject(e);
            });
        }
    }, JOIN_TIMEOUT_MS);

    // send the JOIN with a key if it was specified.
    this.unsafeClient.join(channel + (key ? " " + key : ""), () => {
        this.log.debug("Joined channel %s", channel);
        client.removeListener("error", failFn);
        var room = new IrcRoom(this.server, channel);
        defer.resolve(room);
    });

    return defer.promise;
}

BridgedClient.illegalCharactersRegex = /[^A-Za-z0-9\]\[\^\\\{\}\-`_\|]/g;

module.exports = BridgedClient;
