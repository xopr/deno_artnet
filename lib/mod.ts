export type IntervalId = number;
export type TimeoutId = number;
export type Universe = number;

export function sleep<T>( ms: number, data?: T ): Promise<T>
{
    return new Promise( (resolve) => {
        setTimeout( () => resolve(data as T), ms );
    } )
}

export interface Config
{
    host?: string;
    port?: number;
    refresh?: number;
    sendAll?: boolean;
    iface?: string;
}

export type Callback = (error: unknown, response: unknown) => void;

export * from "./Artnet.ts"
