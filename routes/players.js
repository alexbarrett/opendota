var constants = require('dotaconstants');
var buildPlayer = require('../store/buildPlayer');
var express = require('express');
var players = express.Router();
var querystring = require('querystring');
//list of fields that are numerical (continuous).  These define the possible categories for histograms, trends, and records
var player_fields = constants.player_fields;
var playerPages = constants.player_pages;
playerPages = {
  "index": {
    "name": "Overview"
  },
  "matches": {
    "name": "Matches"
  },
  "heroes": {
    "name": "Heroes"
  },
  "peers": {
    "name": "Peers"
  },
  "pros": {
    "name": "Pros",
    "new-feature": true
  },
  "activity": {
    "name": "Activity"
  },
  "records": {
    "name": "Records"
  },
  "counts": {
    "name": "Counts"
  },
  "histograms": {
    "name": "Histograms"
  },
  "trends": {
    "name": "Trends"
  },
  "wardmap": {
    "name": "Wardmap"
  },
  "items": {
    "name": "Items"
  },
  "wordcloud": {
    "name": "Wordcloud"
  },
  "rating": {
    "name": "MMR"
  },
  "rankings": {
    "name": "Rankings",
  }
};
module.exports = function (db, redis, cassandra)
{
    players.get('/:account_id/:info?/:subkey?', function (req, res, cb)
    {
        console.time("player " + req.params.account_id);
        var info = playerPages[req.params.info] ? req.params.info : "index";
        var subkey = req.params.subkey || "kills";
        buildPlayer(
        {
            db: db,
            redis: redis,
            cassandra: cassandra,
            account_id: req.params.account_id,
            info: info,
            subkey: subkey,
            query: req.query
        }, function (err, player)
        {
            if (err)
            {
                return cb(err);
            }
            if (!player)
            {
                return cb();
            }
            delete req.query.account_id;
            console.timeEnd("player " + req.params.account_id);

            // Builds an option list for the included/excluded player filters.
            var buildPlayerOptions = function(query_param) {
                query_param = query_param || [];
                // Keep track of options added (as peers) so they aren't added again.
                var query_param_items_added = {};
                var peers = player.teammate_list || [];
                var options = peers.map(function(teammate) {
                    var selected = false;
                    if (query_param.indexOf(teammate.account_id) >= 0) {
                        selected = true;
                        query_param_items_added[teammate.account_id] = true;
                    };
                    return {
                        value: teammate.account_id,
                        label: teammate.personaname || teammate.name || teammate.account_id,
                        selected: selected
                    };
                });
                query_param.forEach(function(account_id) {
                    if (!query_param_items_added[account_id]) {
                        options.push({
                            value: account_id,
                            label: account_id,
                            selected: true
                        });
                    }
                });
                return options;
            };

            res.render("player/player_" + info,
            {
                q: req.query,
                querystring: Object.keys(req.query).length ? "?" + querystring.stringify(req.query) : "",
                player: player,
                route: info,
                subkey: subkey,
                tabs: playerPages,
                histograms: player_fields.subkeys,
                times: player_fields.times,
                counts: player_fields.countCats,
                title: (player.profile.personaname || player.profile.account_id),
                filter: {
                    includedPlayers: buildPlayerOptions(req.query.included_account_id),
                    excludedPlayers: buildPlayerOptions(req.query.excluded_account_id)
                }
            });
        });
    });
    //return router
    return players;
};
