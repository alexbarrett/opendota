var db = require('../store/db');
var redis = require('../store/redis');
var cassandra = require('../store/cassandra');
var buildPlayer = require('../store/buildPlayer');

buildPlayer(
{
    db: db,
    redis: redis,
    cassandra: cassandra,
    account_id: process.argv[2], // Pass account_id to get peers for to script.
    info: "peers",
    query: {}
}, function (err, player) {
    player.teammate_list.forEach(function(peer) {
        redis.lpush('profilerQueue', peer.account_id);
    });
    process.exit(0);
});
