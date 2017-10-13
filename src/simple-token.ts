import * as grpc from 'grpc';

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