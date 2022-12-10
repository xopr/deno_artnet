// This is a Deno/typescript "port" of https://github.com/hobbyquaker/artnet
import { Buffer } from "https://deno.land/std@0.156.0/node/buffer.ts";
import dgram, { Socket } from "https://deno.land/std@0.156.0/node/dgram.ts";
import { EventEmitter } from "https://deno.land/std@0.133.0/node/events.ts";
import { ErrnoException } from "https://deno.land/std@0.156.0/node/internal/errors.ts";
import { type Universe, type Config, type IntervalId, sleep } from "./module.ts";

/** ARTnet class */
export class Artnet extends EventEmitter
{
    /** The host/IP to connect to */
    private host:           string;
    /** The port to connect to */
    private port:           number;
    /** Refresh time in milliseconds, defaults to 4000 */
    private readonly refresh:        number;
    /** Whether to send all channels, or only up until the last changed channel */
    private readonly sendAll:        boolean;
    /** The socket used */
    private readonly socket:         Socket;
    /** The 512 DMX channels */
    private readonly data:           number[][];
    /** The interval ids used for the refresh */
    private readonly interval:       IntervalId[];
    /** The throttle timeouts */
    private readonly throttled:      Record<Universe,boolean>;
    /** The highest channel number that had a change. mind that channel counting starts at 1! */
    private readonly dataChanged:    number[];

    constructor(_config?: Config)
    {
        super();

        const config = _config || {};
        this.host =     config.host         || '255.255.255.255';
        this.port =     config.port         || 6454;
        this.refresh =  config.refresh      || 4000;
        this.sendAll =  config.sendAll      || false;

        this.socket = dgram.createSocket({type: 'udp4', reuseAddr: true});

        this.socket.on('error', (err) => {
            this.emit('error', err);
        });

        if (config.iface && (this.host === '255.255.255.255'))
        {
            this.socket.bind(this.port, config.iface, () => {
                this.socket.setBroadcast(true);
            });
        }
        else if (this.host.match(/255$/))
        {
            this.socket.bind(this.port, () => {
                this.socket.setBroadcast(true);
            });
        }

        // Index of the following arrays is the universe
        this.data =         []; // The 512 dmx channels
        this.interval =     []; // The intervals for the 4sec refresh
        this.throttled =    []; // Whether the call is throttled
        this.dataChanged =  []; // The highest channel number that had a change. mind that channel counting starts at 1!
    }

    /**
     * Refresh interval: it will postpone a pending refresh
     * @param universe 
     */
    protected refreshInterval(universe: number): void
    {
        // Reset interval
        if ( this.interval[universe] )
            clearInterval(this.interval[universe]);

        this.interval[universe] = setInterval( () => {
            void this.send(universe, true);
        }, this.refresh);
    }

    /** 
     * Create an ARTnet trigger package
     * See http://www.artisticlicence.com/WebSiteMaster/User%20Guides/art-net.pdf page 40
     * @param oem 
     * @param key 
     * @param subkey 
     * @returns Trigger package
     */
    protected triggerPackage(oem = 0xffff, key = 0xff, subkey = 0): Uint8Array
    {
        const hOem = (oem >> 8) & 0xff;
        const lOem = oem & 0xff;

        // NOTE: when oem is broadcast (0xffff), key determines an action and subkey the data:
        // 0: KeyAscii, 1: KeyMacro, 2: KeySoft, 3: KeyShow
        const header = [65, 114, 116, 45, 78, 101, 116, 0, 0, 153, 0, 14, 0, 0, hOem, lOem, key, subkey];

        // Payload is manufacturer specific
        const payload = new Array(512).fill( 0 );
        return new Uint8Array(header.concat(payload));
    }

    /** Trigger ARTnet (never throttled)
     * @param oem 
     * @param key 
     * @param subkey 
     * @returns null or error if socket failed
     */
    protected trigger(oem: number, key: number, subkey: number): Promise<null | ErrnoException>
    {
        /* [ [ uint15 oem, ] uint9 subkey, ] uint8 key */
        return new Promise( resolve => {
            const buf = this.triggerPackage(oem, key, subkey);
            this.socket.send(buf, 0, buf.length, this.port, this.host, resolve);
        })
    }

    /**
     * Create an ARTnet data package
     * See http://www.artisticlicence.com/WebSiteMaster/User%20Guides/art-net.pdf page 45
     * @param universe 
     * @param length 
     * @returns 
     */
    protected artdmxPackage(universe: number, length = 2): Buffer
    {
        // length = parseInt(length, 10) || 2;
        if (length % 2) {
            length += 1;
        }

        const hUni = (universe >> 8) & 0xff;
        const lUni = universe & 0xff;

        const hLen = (length >> 8) & 0xff;
        const lLen = (length & 0xff);

        const header = [65, 114, 116, 45, 78, 101, 116, 0, 0, 80, 0, 14, 0, 0, lUni, hUni, hLen, lLen];

        if (!this.data[universe])
            this.data[universe] = new Array(512).fill( 0 );

        return Buffer.from(header.concat(this.data[universe].slice(0, (hLen * 256) + lLen)));
    }

    /**
     * Send ARTnet packet
     * @param universe The universe to send the frame to
     * @param refresh Whether to force a full refresh or only up until the highest changed channel
     * @returns null or error if socket failed
     */
    protected async send(universe: number, refresh: boolean): Promise<null | ErrnoException | RangeError>
    {
        if (this.sendAll)
            refresh = true;

        this.refreshInterval(universe);

        if (this.throttled[universe])
            return Promise.reject( new RangeError( "Call already pending" ) );
        this.throttled[universe] = true;

        const buf = this.artdmxPackage(universe, refresh ? 512 : this.dataChanged[universe]);
        this.dataChanged[universe] = 0;

        const promise = new Promise<null | ErrnoException>( resolve => {
            this.socket.send(buf, 0, buf.length, this.port, this.host, resolve);
        } );

        await sleep( 25 );
        this.throttled[universe] = false;
        return promise;
    }

    /**
     * Set a universe's channel value
     * @param value The value to use (0-255)
     * @param channel The channel to set
     * @param universe The universe we want to update
     * @returns null or error if socket failed
     */
    public set( value: number | number[], channel = 1, universe = 0 ): Promise<null | ErrnoException>
    {
        if (!this.data[universe])
            this.data[universe] = new Array(512).fill( 0 );

        this.dataChanged[universe] = this.dataChanged[universe] || 0;

        let index: number;
        if ((typeof value === 'object') && (value.length > 0)) {
            for (let i = 0; i < value.length; i++) {
                index = channel + i - 1;
                if (typeof value[i] === 'number' && this.data[universe][index] !== value[i]) {
                    this.data[universe][index] = value[i];
                    if ((index + 1) > this.dataChanged[universe]) {
                        this.dataChanged[universe] = index + 1;
                    }
                }
            }
        } else if (typeof value === 'number' && this.data[universe][channel - 1] !== value) {
            this.data[universe][channel - 1] = value;
            if (channel > this.dataChanged[universe]) {
                this.dataChanged[universe] = channel;
            }
        }

        if (this.dataChanged[universe])
            return this.send(universe, false);

        return Promise.resolve(null);
    }

    /**
     * Close ARTnet connection
     */
    public close()
    {
        let i: number;
        for (i = 0; i < this.interval.length; i++) {
            clearInterval(this.interval[i]);
        }
        this.socket.close();
    }

    /**
     * Set new target host
     * @param host the new host/IP to use
     */
    public setHost(host: string)
    {
        this.host = host;
    }

    /**
     * Set new target port
     * @param port The new port to use
     */
    public setPort(port: number)
    {
        if (this.host === "255.255.255.255")
            throw new Error("Can't change port when using broadcast address 255.255.255.255");
        else
            this.port = port;
    }
}
