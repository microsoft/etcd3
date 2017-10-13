import * as grpc from 'grpc';

/**
 * A singleton to set a token and put it inside a grpc.Metadata object.
 * Before calls, the metadata object will be asked and pass to the exec function.
 */
export class SimpleToken {

    private static _instance: SimpleToken;
    public static get Instance() {
        return this._instance || (this._instance = new this());
    }

    private _metadata: grpc.Metadata;

    private constructor() {
        this._metadata = new grpc.Metadata();
    }

    public get metadata(): grpc.Metadata {
        return this._metadata;
    }

    public setToken(token: string) {
        const meta = new grpc.Metadata();
        meta.add('token', token);
        this._metadata = meta;
    }

}
