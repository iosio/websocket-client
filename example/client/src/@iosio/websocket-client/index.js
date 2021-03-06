import {isFunction, isString, isObject} from "@iosio/utils/lib/type_checks";
import {Eventer} from '@iosio/utils/lib/eventer';
import {tryParse} from '@iosio/utils/lib/string_manipulation';
import {uniqueID} from '@iosio/utils/lib/number_generation';


/*
    webSocket readyStates
    0 - connecting
    1 - open
    2 - closing
    3 - closed
 */


export default class Socket {

    /**
     * Creates an instance of Socket.
     * @param {Object} config - the initial configuration for the module
     * @memberof Socket
     */
    constructor(config) {

        if (!config) {
            console.error('missing required config object for socket. required config:');
            return;
        }

        const {
            websocket,
            url,
            websocket_options,
            auto_reconnect,
            requestMapper,
            sendMapper,
            should_console_log
        } = config;

        if (!url) {
            console.error('missing required url for socket');
        }

        this._url = url ? url : null;
        this._auto_reconnect = auto_reconnect ? auto_reconnect : false;
        this._websocket_options = websocket_options;


        this._requestMapper = null;
        if (isFunction(requestMapper)) {
            this._requestMapper = requestMapper;
        }

        this._sendMapper = false;
        if (isFunction(sendMapper)) {
            this._sendMapper = sendMapper;
        }

        this._reconnectTimeout = null;
        this._deliberateClose = false;
        this._should_console_log = should_console_log ? should_console_log : false;
        this._WebSocket = websocket ? websocket : WebSocket;
        this._socket = null;


        this.CONNECT = 'connect';
        this.DISCONNECT = 'disconnect';
        this.RECONNECTING = 'reconnecting';
        this.ERROR = 'error';

        this._callbacks = Object.create(null);
        this._eventer = Eventer(this._callbacks);

        this._reconnectionInProgress = false;
    }

    /**
     * Handles emitting when the socket is successfully connected to a websocket server
     * @memberof Socket
     * @returns {undefined}
     */
    _onOpen = () => {
        if (this._reconnectTimeout) {
            clearTimeout(this._reconnectTimeout);
        }
        this._log('socket connected');
        this._eventer.emit(this.CONNECT);
    };

    /**
     * Handles emitting when there is an error
     * @memberof Socket
     * @returns {undefined}
     */
    _onError = () => {
        this._log('socket error');
        this._eventer.emit(this.ERROR);
    };

    /**
     * Handles emitting when the socket's connection is closed.
     * It will also handle auto connection if the connection is not deliberately closed
     * and auto connect is enabled
     * @memberof Socket
     * @returns {undefined}
     *
     *
     * 1000 - CLOSE_NORMAL
     * 1006 - CLOSE_ABNORMAL
     * 1007 - unsupported payload
     * 1011 - Server error (Internal server error while operating)
     * 1012 - Server/service is restarting
     * 1014 - Bad gateway
     * ...
     * https://github.com/Luka967/websocket-close-codes
     *
     */
    _onClose = (e) => {
        // 1000:	// CLOSE_NORMAL
        this._log('socket closed. error code: ', e.code);
        this._eventer.emit(this.DISCONNECT);
        // this._socket.onclose = this._socket.onopen = this._socket.onerror = null;
        if (this._auto_reconnect && !this._deliberateClose) {
            this._attemptReconnect();
        }
    };

    /**
     * Will close the websocket connection deliberately
     * @memberof Socket
     * @returns {undefined}
     */
    close = () => {
        this._deliberateClose = true;
        //clean up rest
        // this._reconnectionInProgress = false;
        if (this._reconnectTimeout) {
            clearInterval(this._reconnectTimeout);
        }
        if (this._isConnected()) {
            this._log('closing socket');
            this._socket && this._socket.close();

        } else {
            this._log('socket is already closed')
        }

    };


    /**
     * Attempts to reconnect on a periodical basis
     * @memberof Socket
     * @returns {undefined}
     */
    _attemptReconnect = () => {

        const time = this._auto_reconnect && this._auto_reconnect.every ? this._auto_reconnect.every : 2000;

        if (this._reconnectTimeout) {
            clearTimeout(this._reconnectTimeout);
        }

        this._log(`attempting reconnect in: ${time}ms`);

        this._reconnectTimeout = setTimeout(() => {

            this._log('attempting to reconnect');

            this._eventer.emit(this.RECONNECTING);

            !this._isConnected() && this.open();

        }, time);


    };


    /**
     * Checks if the received message is in the correct format
     * @param {Object} data - the received data object
     * @memberof Socket
     * @returns {Object} - is the received message valid
     */
    _validateReceivedMessage = (data) => {
        const parsed = tryParse(data);// returns {ok,data,error}

        if (!parsed.ok) {
            this._log('data received from socket does not have valid format. instead received:', parsed.data, true);
            return {ok: false};
        }

        if (!parsed.data.event || typeof parsed.data.event !== 'string') {
            this._log('received messages are required to have an event property of type string', '', true);
            return {ok: false}
        }

        let message = parsed.data;

        if (!this._callbacks[message.event]) {
            this._log('no handler exists from this event received from socket:', message.event, true);
            return {ok: false}
        }

        return {ok: true, message}
    };

    /**
     * Handles emitting when a message is received
     * @param {Object} * - the message received
     *  @property {Object} data the data received from the message
     * @memberof Socket
     * @returns {undefined}
     */
    _onMessage = ({data}) => {
        const validation = this._validateReceivedMessage(data);
        if (!validation.ok) {
            return;
        }

        const {message} = validation;
        this._eventer.emit(message.event, message.data);
        this._isResponse(message.event) && this._eventer.destroy(message.event);
    };

    /**
     * Checks if the websocket is connected
     * @memberof Socket
     * @returns {Boolean} - is the socket connected
     */
    _isConnected = () => {
        return this._socket ? (this._socket.readyState === this._WebSocket.OPEN) : false;
    };

    /**
     * Checks if the message is a response for a named callback emittion
     * @param {*} res - the response
     * @returns {Boolean} - is the data a response
     */
    _isResponse = (res) => isString(res) && res.search('@response-') > -1;


    /**
     * Handles opening a websocket connection to the configured destination
     * @memberof Socket
     * @returns {undefined}
     */
    open = () => {
        this._deliberateClose = false;
        if (this._reconnectTimeout) {
            clearInterval(this._reconnectTimeout);
        }
        this._log('initializing socket');
        if (!this._isConnected()) {
            try {
                this._socket = new this._WebSocket(this._url, this._websocket_options);
            } catch (e) {
                this._log('error instantiating WebSocket', e, true);
                this._socket = false;
            }
            if (!this._socket) {
                return;
            }
            this._socket.onopen = this._onOpen;
            this._socket.onerror = this._onError;
            this._socket.onmessage = this._onMessage;
            this._socket.onclose = this._onClose;
        } else {
            this._log('socket already open');
        }
    };

    /**
     * Checks if the arguments for an event are valid
     * @param {String} event - the name of the event
     * @param {Function} cb  - the callback
     * @memberof Socket
     * @returns {Object} - are the arguments valid
     */
    _isValidOnEventArgs = (event, cb) => {
        if (!isString(event)) {
            this._log('Must provide a string for the event type.', '', true);
            return false;
        }

        if (!isFunction(cb)) {
            this._log('Must provide a function for a callback. Must be named function if you want to remove its listener', '', true);
            return false;
        }

        return true;
    };


    /**
     * Registers an event to be listened for when the websocket client recieves an event from its connected server
     * @param {String} event - the name of the event to listen to
     * @param {Function} cb  - the action to take when the event is received
     * @memberof Socket
     * @returns {undefined}
     */
    on = (event, cb) => {
        this._isValidOnEventArgs(event, cb) && this._eventer.on(event, cb);
    };

    /**
     * Unregisters an event listener
     * @param {String} event - the event name
     * @param {Function} cb  - the callback
     * @memberof Socket
     * @returns {undefined}
     */
    off = (event, cb) => {
        if (this._isValidOnEventArgs(event, cb) && cb.name) {
            this._eventer.off(event, cb);
        } else {
            this.log('callback function passed to .off must also be a named function (not anonymous) ');
        }
    };

    /**
     * Sends a message to the connected websocket server
     * @param {String} event - the event to send
     * @param {Object} data  - the data to send with the event
     * @param {String} response_id - the response id
     * @memberof Socket
     * @returns {undefined}
     */
    send = (event, data = {}, response_id) => {
        if (!this._isConnected()) {
            return;
        }

        if (!isString(event)) {
            this._log('.send must provide a string for the event type.', '', true);
            return;
        }

        let is_request = isString(response_id);
        let message;

        if (is_request) {
            message = {
                event,
                data,
                type: 'request',
                response_id
            };

            if (isFunction(this._requestMapper)) {
                message = this._requestMapper(message);
            }
        } else {
            message = {
                event,
                data,
                type: 'send'
            };

            if (isFunction(this._sendMapper)) {
                message = this._sendMapper(message);
            }
        }

        this._socket.send(JSON.stringify(message));
    };


    /**
     * Validates the params of a request
     * @param {String} event - the event to validate
     * @param {Object|Function} params_or_cb_if_no_params - either the options or the callback
     * @param {Function} cb_if_params - the callback if there are options
     * @memberof Socket
     * @returns {Object} - is the request valid
     */
    _validateRequestArgs = (event, params_or_cb_if_no_params, cb_if_params) => {
        let ok = true;

        if (!isString(event)) {
            this._log('/request method: a string event name is required', '', true);
            ok = false;
        }

        if (!isObject(params_or_cb_if_no_params) && !isFunction(params_or_cb_if_no_params)) {
            this._log('/request method: a params object or callback function is required on the second parameter', '', true);
            ok = false;
        }

        if (isObject(params_or_cb_if_no_params) && !isFunction(cb_if_params)) {
            this._log('/request method: a callback function is required as a third parameter if a param object is passed as the second', '', true);
            ok = false;
        }

        if (!ok) {
            return {ok: false,};
        }

        if (isObject(params_or_cb_if_no_params)) {
            return {
                ok: true,
                params: params_or_cb_if_no_params,
                cb: cb_if_params,
            };

        } else if (isFunction(params_or_cb_if_no_params)) {
            return {
                ok: true,
                params: {},
                cb: params_or_cb_if_no_params,
            };
        }

        return {ok: false,};
    };

    /**
     * Creates a named request to the server, the difference between this and send, is that this function
     * will also register an event listener for the next response based on the name of this event
     * @param {String} event - the name of the event
     * @param {Object|Function} params_or_cb_if_no_params - either params or a callback
     * @param {Function} cb_if_params - params if there is a callback
     * @memberof Socket
     * @returns {undefined}
     */
    request = (event, params_or_cb_if_no_params, cb_if_params) => {
        let {ok, params, cb,} = this._validateRequestArgs(event, params_or_cb_if_no_params, cb_if_params);

        if (!ok) {
            this._log('request arguments are invalid', '', true);
            return;
        }

        const response_id = '@response-' + event + '-' + uniqueID();
        this._log('requesting');
        this.send(event, params, response_id);
        this.on(response_id, cb, true);
    };


    /**
     * Handles logging if logging is enabled
     * @param {String} msg - the message to log
     * @param {String} arg - any arguments to log with the message
     * @param {Boolean} error - is this an error
     * @memberof Socket
     * @returns {undefined}
     */
    _log = (msg, arg = "", error) => {
        if (this._should_console_log) {
            error ? console.error('Socket.js: ' + msg, arg) : console.info('Socket.js: ' + msg, arg);
        }
    };

}