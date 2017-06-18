---------------------------- MODULE Etcd3Watcher ----------------------------

EXTENDS TLC

(***************************************************************************)
(* Declarations of the GRPC connection state                               *)
(***************************************************************************)
CONSTANT Idle, Connected, Connecting
CONSTANT Unsubscribing, Unsubscribed, Subscribing, Subscribed

(***************************************************************************
--algorithm Watch {
    variable socket = Idle, watcher = Unsubscribed;

    (************************************************************************)
    (* Small 'hack' to get around macro expansion only providing us access  *)
    (* to socket' rather than socket, which prevents us from verifying      *)
    (* transitions.                                                         *)
    (************************************************************************)
    define { prevSocket == socket }

    macro CheckInvariants() {
        assert socket \in {Idle, Connected, Connecting};
        assert watcher \in {Subscribed, Subscribing, Unsubscribed, Unsubscribing};
        assert socket = Connected \/ watcher # Subscribed;

        if (prevSocket = Unsubscribing) {
            assert watcher \in {Unsubscribing, Unsubscribed}
        } else if (prevSocket = Subscribing) {
            assert watcher \in {Subscribing, Subscribed}
        }
    }

    (************************************************************************)
    (* Watcher is the class attached to the manager that handles the state  *)
    (* of an individual subscription. It can requset to be subscribed or    *)
    (* unsubscribed at any time.                                            *)
    (************************************************************************)
    process (Watcher = 0) { l0: while (TRUE) {
        watch:
            either {
                watcher := Unsubscribing;
                await watcher = Unsubscribed
            } or {
                watcher := Subscribing;
                await watcher = Subscribed
            } or { skip }
        }
    }

    (************************************************************************)
    (* The manager handles global socket state and reconnections.           *)
    (************************************************************************)
    process (Manager = 1) { l1: while (TRUE) {
            if (socket = Idle) {
                goto connect
            } else {
                either goto connected or goto disconnect
            };

        disconnect:
            (************************************************************)
            (* Transitioning from "connected" or "connecting" to        *)
            (* "disonnectined". The watcher gets kicked off if they ask *)
            (* to be, otherwise we mark it as reconnecting.             *)
            (************************************************************)
            if (socket \in {Unsubscribed, Unsubscribing}) {
                watcher := Unsubscribed
            } else {
                watcher := Subscribing
            };

            socket := Idle;
            CheckInvariants();

        connect:
            (************************************************************)
            (* Transitioning from "disconnecting" to "connecting". If   *)
            (* the watcher wants to be unsubscribed, unsubscribe here!  *)
            (************************************************************)
            assert socket = Idle;
            if (watcher \in {Unsubscribed, Unsubscribing}) {
                watcher := Unsubscribed
            };
            socket := Connecting;
            CheckInvariants();

        connected:
            (************************************************************)
            (* In contact the server, the watcher will be unsubscribed  *)
            (* if it asked to be, or connecting if it's subscribing.    *)
            (************************************************************)
            socket := Connected;
            if (socket = Subscribing) {
                watcher := Subscribed
            } else if (socket = Unsubscribing) {
                watcher := Unsubscribed
            };

            CheckInvariants();
        }
    }
}
 ***************************************************************************)
\* BEGIN TRANSLATION
VARIABLES socket, watcher, pc

(* define statement *)
prevSocket == socket


vars == << socket, watcher, pc >>

ProcSet == {0} \cup {1}

Init == (* Global variables *)
        /\ socket = Idle
        /\ watcher = Unsubscribed
        /\ pc = [self \in ProcSet |-> CASE self = 0 -> "l0"
                                        [] self = 1 -> "l1"]

l0 == /\ pc[0] = "l0"
      /\ pc' = [pc EXCEPT ![0] = "watch"]
      /\ UNCHANGED << socket, watcher >>

watch == /\ pc[0] = "watch"
         /\ \/ /\ watcher' = Unsubscribing
               /\ watcher' = Unsubscribed
            \/ /\ watcher' = Subscribing
               /\ watcher' = Subscribed
            \/ /\ TRUE
               /\ UNCHANGED watcher
         /\ pc' = [pc EXCEPT ![0] = "l0"]
         /\ UNCHANGED socket

Watcher == l0 \/ watch

l1 == /\ pc[1] = "l1"
      /\ IF socket = Idle
            THEN /\ pc' = [pc EXCEPT ![1] = "connect"]
            ELSE /\ \/ /\ pc' = [pc EXCEPT ![1] = "connected"]
                    \/ /\ pc' = [pc EXCEPT ![1] = "disconnect"]
      /\ UNCHANGED << socket, watcher >>

disconnect == /\ pc[1] = "disconnect"
              /\ IF socket \in {Unsubscribed, Unsubscribing}
                    THEN /\ watcher' = Unsubscribed
                    ELSE /\ watcher' = Subscribing
              /\ socket' = Idle
              /\ Assert(socket' \in {Idle, Connected, Connecting},
                        "Failure of assertion at line 23, column 9 of macro called at line 74, column 13.")
              /\ Assert(watcher' \in {Subscribed, Subscribing, Unsubscribed, Unsubscribing},
                        "Failure of assertion at line 24, column 9 of macro called at line 74, column 13.")
              /\ Assert(socket' = Connected \/ watcher' # Subscribed,
                        "Failure of assertion at line 25, column 9 of macro called at line 74, column 13.")
              /\ IF prevSocket = Unsubscribing
                    THEN /\ Assert(watcher' \in {Unsubscribing, Unsubscribed},
                                   "Failure of assertion at line 28, column 13 of macro called at line 74, column 13.")
                    ELSE /\ IF prevSocket = Subscribing
                               THEN /\ Assert(watcher' \in {Subscribing, Subscribed},
                                              "Failure of assertion at line 30, column 13 of macro called at line 74, column 13.")
                               ELSE /\ TRUE
              /\ pc' = [pc EXCEPT ![1] = "connect"]

connect == /\ pc[1] = "connect"
           /\ Assert(socket = Idle,
                     "Failure of assertion at line 81, column 13.")
           /\ IF watcher \in {Unsubscribed, Unsubscribing}
                 THEN /\ watcher' = Unsubscribed
                 ELSE /\ TRUE
                      /\ UNCHANGED watcher
           /\ socket' = Connecting
           /\ Assert(socket' \in {Idle, Connected, Connecting},
                     "Failure of assertion at line 23, column 9 of macro called at line 86, column 13.")
           /\ Assert(watcher' \in {Subscribed, Subscribing, Unsubscribed, Unsubscribing},
                     "Failure of assertion at line 24, column 9 of macro called at line 86, column 13.")
           /\ Assert(socket' = Connected \/ watcher' # Subscribed,
                     "Failure of assertion at line 25, column 9 of macro called at line 86, column 13.")
           /\ IF prevSocket = Unsubscribing
                 THEN /\ Assert(watcher' \in {Unsubscribing, Unsubscribed},
                                "Failure of assertion at line 28, column 13 of macro called at line 86, column 13.")
                 ELSE /\ IF prevSocket = Subscribing
                            THEN /\ Assert(watcher' \in {Subscribing, Subscribed},
                                           "Failure of assertion at line 30, column 13 of macro called at line 86, column 13.")
                            ELSE /\ TRUE
           /\ pc' = [pc EXCEPT ![1] = "connected"]

connected == /\ pc[1] = "connected"
             /\ socket' = Connected
             /\ IF socket' = Subscribing
                   THEN /\ watcher' = Subscribed
                   ELSE /\ IF socket' = Unsubscribing
                              THEN /\ watcher' = Unsubscribed
                              ELSE /\ TRUE
                                   /\ UNCHANGED watcher
             /\ Assert(socket' \in {Idle, Connected, Connecting},
                       "Failure of assertion at line 23, column 9 of macro called at line 100, column 13.")
             /\ Assert(watcher' \in {Subscribed, Subscribing, Unsubscribed, Unsubscribing},
                       "Failure of assertion at line 24, column 9 of macro called at line 100, column 13.")
             /\ Assert(socket' = Connected \/ watcher' # Subscribed,
                       "Failure of assertion at line 25, column 9 of macro called at line 100, column 13.")
             /\ IF prevSocket = Unsubscribing
                   THEN /\ Assert(watcher' \in {Unsubscribing, Unsubscribed},
                                  "Failure of assertion at line 28, column 13 of macro called at line 100, column 13.")
                   ELSE /\ IF prevSocket = Subscribing
                              THEN /\ Assert(watcher' \in {Subscribing, Subscribed},
                                             "Failure of assertion at line 30, column 13 of macro called at line 100, column 13.")
                              ELSE /\ TRUE
             /\ pc' = [pc EXCEPT ![1] = "l1"]

Manager == l1 \/ disconnect \/ connect \/ connected

Next == Watcher \/ Manager

Spec == Init /\ [][Next]_vars

\* END TRANSLATION

=============================================================================
\* Modification History
\* Last modified Thu Jun 15 08:44:17 PDT 2017 by Connor
\* Created Thu Jun 15 08:07:31 PDT 2017 by Connor
