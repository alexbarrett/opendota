var express = require('express');
var multiparty = require('multiparty');
var Recaptcha = require('recaptcha').Recaptcha;
var rc_public = process.env.RECAPTCHA_PUBLIC_KEY;
var rc_secret = process.env.RECAPTCHA_SECRET_KEY;
var recaptcha = new Recaptcha(rc_public, rc_secret);
var utility = require('./utility');
var redis = utility.redis;
var db = utility.db;
var logger = utility.logger;
var session = require('express-session');
var RedisStore = require('connect-redis')(session);
var queries = require('./queries'),
    auth = require('http-auth'),
    async = require('async'),
    path = require('path'),
    passport = require('passport'),
    moment = require('moment'),
    bodyParser = require('body-parser'),
    kue = utility.kue,
    SteamStrategy = require('passport-steam').Strategy,
    app = express(),
    host = process.env.ROOT_URL || "http://localhost:5000";
var matchPages = {
    index: {
        template: "match_index",
        name: "Match"
    },
    details: {
        template: "match_details",
        name: "Details"
    },
    timelines: {
        template: "match_timelines",
        name: "Timelines"
    },
    graphs: {
        template: "match_graphs",
        name: "Graphs"
    },
    chat: {
        template: "match_chat",
        name: "Chat"
    }
};
var playerPages = {
    index: {
        template: "player_index",
        name: "Player"
    },
    matches: {
        template: "player_matches",
        name: "Matches"
    },
    stats: {
        template: "player_stats",
        name: "Statistics"
    }
};
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');
app.locals.moment = moment;
app.locals.constants = require('./constants.json');
passport.serializeUser(function(user, done) {
    done(null, user.account_id);
});
passport.deserializeUser(function(id, done) {
    db.players.findOne({
        account_id: id
    }, function(err, user) {
        done(err, user);
    });
});
passport.use(new SteamStrategy({
    returnURL: host + '/return',
    realm: host,
    apiKey: process.env.STEAM_API_KEY
}, function(identifier, profile, done) {
    var steam32 = Number(utility.convert64to32(identifier.substr(identifier.lastIndexOf("/") + 1)));
    var insert = profile._json;
    insert.account_id = steam32;
    insert.join_date = new Date();
    insert.full_history = 0;
    insert.track = 1;
    db.players.insert(insert, function(err, doc) {
        //if already exists, just find and return the user
        if (err) {
            db.players.findOne({
                account_id: steam32
            }, function(err, doc) {
                return done(err, doc);
            });
        }
        else {
            return done(err, doc);
        }
    });
}));
var basic = auth.basic({
    realm: "Kue"
}, function(username, password, callback) { // Custom authentication method.
    callback(username === (process.env.KUE_USER || "user") && password === (process.env.KUE_PASS || "pass"));
});
app.use("/kue", auth.connect(basic));
app.use("/kue", kue.app);
app.use("/public", express.static(path.join(__dirname, '/public')));
app.use(session({
    store: new RedisStore({
        client: redis
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(bodyParser.urlencoded({
    extended: false
}));
app.use(function(req, res, next) {
    redis.get("banner", function(err, reply) {
        if (err) {
            logger.info(err);
        }
        res.locals.user = req.user;
        //app.locals.login_req_msg = req.session.login_required;
        //req.session.login_required = false;
        res.locals.banner_msg = reply;
        if (req.user) {
            db.players.update({
                account_id: req.user.account_id
            }, {
                $set: {
                    track: 1,
                    last_visited: new Date()
                }
            }, function(err) {
                console.log("%s visit", req.user.account_id);
                next(err);
            });
        }
        else {
            console.log("anonymous visit");
            next();
        }
    });
});
app.param('match_id', function(req, res, next, id) {
    redis.get(id, function(err, reply) {
        if (err || !reply) {
            logger.info("Cache miss for match " + id);
            db.matches.findOne({
                match_id: Number(id)
            }, function(err, match) {
                if (err || !match) {
                    return next(new Error("match not found"));
                }
                else {
                    queries.fillPlayerNames(match.players, function(err) {
                        if (err) {
                            return next(new Error(err));
                        }
                        req.match = match;
                        if (match.parsed_data) {
                            queries.mergeMatchData(match, app.locals.constants);
                            queries.generateGraphData(match, app.locals.constants);
                        }
                        //Add to cache if we have parsed data
                        if (match.parsed_data && process.env.NODE_ENV !== "development") {
                            redis.setex(id, 86400, JSON.stringify(match));
                        }
                        return next();
                    });
                }
            });
        }
        else if (reply) {
            logger.info("Cache hit for match " + id);
            req.match = JSON.parse(reply);
            return next();
        }
    });
});
app.route('/').get(function(req, res) {
    res.render('index.jade', {});
});
app.route('/api/items').get(function(req, res) {
    res.json(app.locals.constants.items[req.query.name]);
});
app.route('/api/abilities').get(function(req, res) {
    res.json(app.locals.constants.abilities[req.query.name]);
});
app.route('/api/matches').get(function(req, res, next) {
    var options = {};
    var sort = {};
    var limit = Number(req.query.length) || 10;
    if (req.query.draw) {
        var ajaxData = req.query.search.value;
        options = utility.makeSearch(ajaxData, req.query.columns);
        sort = utility.makeSort(req.query.order, req.query.columns);
    }
    db.matches.count(options, function(err, count) {
        if (err) {
            return next(new Error(err));
        }
        db.matches.find(options, {
            limit: limit,
            skip: Number(req.query.start),
            sort: sort,
            fields: {
                start_time: 1,
                match_id: 1,
                cluster: 1,
                parse_status: 1,
                game_mode: 1,
                duration: 1
            }
        }, function(err, docs) {
            if (err) {
                return next(err);
            }
            res.json({
                draw: Number(req.query.draw),
                recordsTotal: count,
                recordsFiltered: count,
                data: docs
            });
        });
    });
});
app.route('/matches').get(function(req, res) {
    res.render('matches.jade', {
        title: "Matches - YASP"
    });
});
app.route('/matches/:match_id/:info?').get(function(req, res, next) {
    var match = req.match;
    var info = req.params.info || "index";
    //handle bad info
    if (!matchPages[info]) {
        return next(new Error("page not found"));
    }
    res.render(matchPages[info].template, {
        route: info,
        match: match,
        tabs: matchPages,
        title: "Match " + match.match_id + " - YASP"
    });
});
app.route('/players/:account_id/:info?').get(function(req, res, next) {
    var account_id = Number(req.params.account_id);
    var info = req.params.info || "index";
    //handle bad info
    if (!playerPages[info]) {
        return next(new Error("page not found"));
    }
    db.players.findOne({
        account_id: account_id
    }, function(err, player) {
        if (err || !player) {
            return next(new Error("player not found"));
        }
        else {
            db.matches.find({
                'players.account_id': account_id
            }, {
                fields: {
                    start_time: 1,
                    match_id: 1,
                    game_mode: 1,
                    duration: 1,
                    cluster: 1,
                    radiant_win: 1,
                    parse_status: 1,
                    "players.$": 1
                },
                sort: {
                    match_id: -1
                }
            }, function(err, matches) {
                if (err) {
                    return next(err);
                }
                player.matches = matches;
                player.win = 0;
                player.lose = 0;
                player.games = 0;
                player.heroes = {};
                player.histogramData = {};
                player.radiantMap = {};
                var calheatmap = {};
                //array to store match durations in minutes
                var arr = Array.apply(null, new Array(120)).map(Number.prototype.valueOf, 0);
                var arr2 = Array.apply(null, new Array(120)).map(Number.prototype.valueOf, 0);
                var heroes = player.heroes;
                for (var i = 0; i < matches.length; i++) {
                    calheatmap[matches[i].start_time] = 1;
                    var mins = Math.floor(matches[i].duration / 60) % 120;
                    arr[mins] += 1;
                    var gpm = Math.floor(matches[i].players[0].gold_per_min / 10) % 120;
                    arr2[gpm] += 1;
                    var p = matches[i].players[0];
                    player.radiantMap[matches[i].match_id] = utility.isRadiant(p);
                    matches[i].player_win = (player.radiantMap[matches[i].match_id] === matches[i].radiant_win); //did the player win?
                    player.games += 1;
                    matches[i].player_win ? player.win += 1 : player.lose += 1;
                    if (!heroes[p.hero_id]) {
                        heroes[p.hero_id] = {
                            games: 0,
                            win: 0,
                            lose: 0
                        };
                    }
                    heroes[p.hero_id].games += 1;
                    matches[i].player_win ? heroes[p.hero_id].win += 1 : heroes[p.hero_id].lose += 1;
                }
                player.histogramData.durations = arr;
                player.histogramData.gpms = arr2;
                player.histogramData.calheatmap = calheatmap;
                var renderOpts = {
                    route: info,
                    player: player,
                    tabs: playerPages,
                    title: (player.personaname || player.account_id) + " - YASP"
                };
                if (info === "stats") {
                    queries.computeStatistics(player, function(err) {
                        if (err) {
                            return next(err);
                        }
                        //render
                        res.render(playerPages[info].template, renderOpts);
                    });
                }
                else {
                    res.render(playerPages[info].template, renderOpts);
                }
            });
        }
    });
});
app.route('/preferences').post(function(req, res) {
    if (req.user) {
        db.players.update({
            account_id: req.user.account_id
        }, {
            $set: {
                "dark_theme": req.body.dark === 'true' ? 1 : 0
            }
        }, function(err, num) {
            var success = !(err || !num);
            res.json({
                sync: success
            });
        });
    }
    else {
        res.json({
            sync: false
        });
    }
});
app.route('/login').get(passport.authenticate('steam', {
    failureRedirect: '/'
}));
app.route('/return').get(
    passport.authenticate('steam', {
        failureRedirect: '/'
    }),
    function(req, res) {
        if (req.user) {
            res.redirect('/players/' + req.user.account_id);
        }
        else {
            res.redirect('/');
        }
    }
);
app.route('/logout').get(function(req, res) {
    req.logout();
    req.session.destroy(function(err) {
        res.redirect('/');
    })
});

app.route('/verify_recaptcha')
    .post(function(req, res) {
        var data = {
            remoteip: req.connection.remoteAddress,
            challenge: req.body.recaptcha_challenge_field,
            response: req.body.recaptcha_response_field
        };
        var recaptcha = new Recaptcha(rc_public, rc_secret, data);
        recaptcha.verify(function(success, error_code) {
            req.session.captcha_verified = success;
            res.json({
                verified: success
            });
        });
    });
app.route('/upload')
    .all(function(req, res, next) {
        next();
    })
    .get(function(req, res) {
        res.render("upload", {
            recaptcha_form: recaptcha.toHTML(),
        });
    })
    .post(function(req, res, next) {
        if (req.session.captcha_verified || process.env.NODE_ENV === "test") {
            req.session.captcha_verified = false; //Set back to false
            var form = new multiparty.Form();
            var parser = utility.runParse(function(err, output) {
                //todo get api data out of replay in case of private
                //todo do private/local lobbies have an id?
                if (err) {
                    return next(err);
                }
                var match_id = output.match_id;
                console.log(match_id);
                db.matches.findOne({
                    match_id: match_id
                }, function(err, doc) {
                    if (err) {
                        return next(err);
                    }
                    else if (doc) {
                        console.log("match found in db");
                        db.matches.update({
                            match_id: match_id
                        }, {
                            $set: {
                                parsed_data: output,
                                parse_status: 2
                            }
                        }, function(err) {
                            if (err) {
                                console.log(err);
                            }
                            res.redirect("/matches/" + match_id);

                        });
                    }
                    else if (match_id) {
                        console.log("match not found in db");
                        utility.queueReq("api_details", {
                            match_id: match_id,
                            parsed_data: output,
                            priority: "high"
                        }, function(err, job) {
                            if (err) {
                                return next(err);
                            }
                            job.on('complete', function() {
                                res.redirect("/matches/" + match_id);
                            });
                        });
                    }
                    else {
                        res.json({
                            error: "couldn't detect match_id"
                        });
                    }
                });
            });
            form.on('part', function(part) {
                if (part.filename) {
                    part.pipe(parser.stdin);
                }
            });
            form.on('error', function(err) {
                console.log(err);
                parser.kill();
            });
            form.parse(req);
        }
    });
app.route('/status').get(function(req, res, next) {
    async.parallel({
            matches: function(cb) {
                db.matches.count({}, function(err, res) {
                    cb(err, res);
                });
            },
            players: function(cb) {
                db.players.count({}, function(err, res) {
                    cb(err, res);
                });
            },
            visited_last_day: function(cb) {
                db.players.count({
                    last_visited: {
                        $gt: moment().subtract(1, 'day').toDate()
                    }
                }, function(err, res) {
                    cb(err, res);
                });
            },
            tracked_players: function(cb) {
                db.players.count({
                    track: 1
                }, function(err, res) {
                    cb(err, res);
                });
            },
            untracked_players: function(cb) {
                db.players.count({
                    track: 0
                }, function(err, res) {
                    cb(err, res);
                });
            },
            matches_last_day: function(cb) {
                db.matches.count({
                    start_time: {
                        $gt: Number(moment().subtract(1, 'day').format('X'))
                    }
                }, function(err, res) {
                    cb(err, res);
                });
            },
            unavailable_last_week: function(cb) {
                db.matches.count({
                    start_time: {
                        $gt: Number(moment().subtract(7, 'day').format('X'))
                    },
                    parse_status: 1
                }, function(err, res) {
                    cb(err, res);
                });
            },
            queued_matches: function(cb) {
                db.matches.count({
                    parse_status: 0
                }, function(err, res) {
                    cb(err, res);
                });
            },
            unavailable_matches: function(cb) {
                db.matches.count({
                    parse_status: 1
                }, function(err, res) {
                    cb(err, res);
                });
            },
            parsed_matches: function(cb) {
                db.matches.count({
                    parse_status: 2
                }, function(err, res) {
                    cb(err, res);
                });
            },
            parsed_matches_last_day: function(cb) {
                db.matches.count({
                    parse_status: 2,
                    start_time: {
                        $gt: Number(moment().subtract(1, 'day').format('X'))
                    }
                }, function(err, res) {
                    cb(err, res);
                });
            },
            eligible_full_history: function(cb) {
                db.players.count(utility.fullHistoryEligible(), function(err, res) {
                    cb(err, res);
                });
            },
            obtained_full_history: function(cb) {
                db.players.count({
                    full_history: 2
                }, function(err, res) {
                    cb(err, res);
                });
            },
        },
        function(err, results) {
            if (err) {
                return next(err);
            }
            res.render("status", {
                results: results
            });
        });
});
app.route('/about').get(function(req, res, next) {
    res.render("about");
});
app.use(function(req, res, next) {
    res.status(404);
    if (process.env.NODE_ENV !== "development") {
        return res.render('404.jade', {
            error: true
        });
    }
    else {
        next();
    }
});
app.use(function(err, req, res, next) {
    //logger.info(err);
    if (err && process.env.NODE_ENV !== "development") {
        return res.status(500).render('500.jade', {
            error: true
        });
    }
    else {
        next(err);
    }
});

module.exports = app;