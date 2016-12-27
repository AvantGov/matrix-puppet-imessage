let bridge;
const config = require('./config.json')
const Cli = require("matrix-appservice-bridge").Cli;
const Bridge = require("matrix-appservice-bridge").Bridge;
const AppServiceRegistration = require("matrix-appservice-bridge").AppServiceRegistration;
const iMessageSend = require('./send-message');
const nodePersist = require('node-persist');
const storage = nodePersist.create({
  dir:'persist/rooms',
  stringify: JSON.stringify,
  parse: JSON.parse,
  encoding: 'utf8',
  logging: false,
  continuous: true,
  interval: false,
  ttl: false
})
const Promise = require('bluebird');

let lastMsgsFromMyself = [];

new Cli({
  port: config.port,
  registrationPath: config.registrationPath,
  generateRegistration: function(reg, callback) {
    reg.setId(AppServiceRegistration.generateToken());
    reg.setHomeserverToken(AppServiceRegistration.generateToken());
    reg.setAppServiceToken(AppServiceRegistration.generateToken());
    reg.setSenderLocalpart("imessagebot");
    reg.addRegexPattern("users", "@imessage_.*", true);
    callback(reg);
  },
  run: function(port, _config) {
    bridge = new Bridge({
      homeserverUrl: config.bridge.homeserverUrl,
      domain: config.bridge.domain,
      registration: config.bridge.registration,
      controller: {
        onUserQuery: function(queriedUser) {
          console.log('got user query');
          return {} // auto provision users w no additional data
        },
        onEvent: function({data: { type, room_id, content: { body }}}, context) {
          console.log('got incoming matrix request of type', type);
          //console.log(request, context);
          //console.log('req data type', request.data.type);
          if (type === "m.room.message") {
            console.log('handing message from matrix user');
            console.log('room id', room_id);
            console.log('message', body);

            lastMsgsFromMyself.push(body);
            while(lastMsgsFromMyself.length > 10)
            {
              lastMsgsFromMyself.shift();
            }

            storage.getItem(room_id).then((meta) => {
              if ( meta && meta.handle ) {
                console.log('i must deliver this to', meta.handle);
                console.log('ok delivering it using ' + meta.service);
                iMessageSend(meta.handle, body, meta.service != "iMessage" ? "sms" : "iMessage");
              }
            })
          }
        },
        onAliasQuery: function() {
          console.log('on alias query');
        },
        thirdPartyLookup: {
          protocols: ["imessage"],
          getProtocol: function() {
            console.log('get proto');
          },
          getLocation: function() {
            console.log('get loc');
          },
          getUser: function() {
            console.log('get user');
          }
        }
      }
    });
    console.log('Matrix-side listening on port %s', port);
    bridge.run(port, config);
  }
}).run();

module.exports = function() {
  this.init = () => storage.init();

  this.handleIncoming = (msg, markSent, fileRecipient) => {
    return new Promise(function(resolve, reject) {
      console.log('handling incoming message from apple', msg);
      let roomHandle = msg.isMe ? msg.subject : msg.sender;
      const ghost = msg.isMe ? "@imessage_"+msg.subject+":"+config.bridge.domain : "@imessage_"+msg.sender+":"+config.bridge.domain;

      // TODO: These various setDisplayName/setRoomName/etc calls should move
      // into the createRoom block below, but development is in flux at the
      // moment, so I'm running them every time for a while before moving them
      // there.
      let intent = bridge.getIntent(ghost);
      if(fileRecipient)
      {
        intent.setDisplayName(fileRecipient);
      }

      let selfIntent = bridge.getIntent("@imessage_" + config.ownerSelfName + ":" + config.bridge.domain);
      selfIntent.setDisplayName("Me (from iMsg)");
      let sendMsgIntent = msg.isMe ? selfIntent : intent;

      if(msg.isMe && lastMsgsFromMyself.indexOf(msg.message) != -1 ) // Lol, hacks... there are so many ways this can not work.
      {
        console.log("Bailing on mirroring of self-sent message from iMessage/Messages app.");
        console.log("Would result in identical message - perhaps it was actually sent using matrix?");
        return markSent();
      }

      return storage.getItem(ghost).then((meta) => {
        if (meta && meta.room_id) {
          console.log('found room', meta);

          storage.getItem(meta.room_id).then((handleMeta) => {
            if (handleMeta && handleMeta.handle) {
              if (msg.service != handleMeta.service) {
                console.log("service has changed from " + meta.service + " to " + msg.service + ". persisting...");
                handleMeta.service = msg.service;
                storage.setItem(meta.room_id, handleMeta);
              }
            }
          });

          return meta;
        } else {
          return intent.createRoom({ createAsClient: true }).then(({room_id}) => {
            let meta = {
              room_id,
              "service": msg.service
            };

            console.log('created room', meta);
            // we need to store room_id => imessage handle
            // in order to fulfill responses from the matrix user
            return storage.setItem(room_id, { handle: roomHandle, service: msg.service }).then(() => {
              // and store the room ID info so we don't create dupe rooms
              return storage.setItem(ghost, meta)
            }).then(()=>meta);
          })
        }
      }).then((meta) => {
        console.log('!!!!!!!!sending message', msg.message);

        // TODO Ultimately this should move into the createRoom block. Also, it
        // can probably just be passed as an option to createRoom
        intent.setRoomName(meta.room_id, fileRecipient + " (iMsg)");
        intent.setPowerLevel(meta.room_id, config.owner, 100);

        // let's mark as sent early, because this is important for preventing
        // duplicate messages showing up. i want to make sure this happens...
        // XXX but it is a little shitty to do this now, before actually knowing
        // we successfully sent. but for now i would rather prevent dupes, and
        // if we host this close (LAN) to the homeserver then maybe the
        // intent.sendText will succeed very reliably anyway.
        return markSent().then(function() {
          return sendMsgIntent.sendMessage(meta.room_id, { body: msg.message, msgtype: "m.notice" } ).then(function() {
            // XXX need to check first if the owner is already in the room
            intent.invite(meta.room_id, config.owner).then(function() {
              console.log('invited user', config.owner);
            }).catch(function(err) {
              console.log('failed to invite, user probably already in the room');
            });
          })
        })
      }).catch(function(err) {
        console.log(err);
      })
    });
  }
}
