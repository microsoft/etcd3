import { Range } from './range';
import { AuthClient, Permission } from './rpc';
import { toBuffer } from './util';

/**
 * IPermission can be used to grant a certain role in etcd access to a certain
 * key range, or prefix.
 */
export type IPermissionRequest =
  { permission: keyof typeof Permission, range: Range } |
  { permission: keyof typeof Permission, key: Buffer | string };

function getRange(req: IPermissionRequest): Range {
  if (req.hasOwnProperty('key')) {
    return new Range(toBuffer((<{ key: Buffer | string }> req).key));
  }

  return (<{ range: Range }> req).range;
}

/**
 * IGrant is used for granting a permission to a user.
 */
export interface IPermissionResult {
  permission: keyof typeof Permission;
  range: Range;
}

/**
 * The Role provides an entry point for managing etcd roles. Etcd has an
 * ACL-esque system: users have one or more roles, and roles have one or
 * more permissions that grant them access (read, write, or both) on key
 * ranges.
 */
export class Role {
  constructor(
    private client: AuthClient,
    public readonly name: string,
  ) {}

  /**
   * Creates the role in etcd.
   */
  public create(): Promise<this> {
    return this.client.roleAdd({ name: this.name }).then(() => this);
  }

  /**
   * Deletes the role from etcd.
   */
  public delete(): Promise<this> {
    return this.client.roleDelete({ role: this.name }).then(() => this);
  }

  /**
   * Removes a permission from the role in etcd.
   */
  public revoke(req: IPermissionRequest | IPermissionRequest[]): Promise<this> {
    if (req instanceof Array) {
      return Promise.all(req.map(r => this.grant(r))).then(() => this);
    }

    const range = getRange(req);
    return this.client.roleRevokePermission({
      role: this.name,
      key: range.start.toString(),
      range_end: range.end.toString(),
    })
    .then(() => this);
  }

  /**
   * Grants one or more permissions to this role.
   */
  public grant(req: IPermissionRequest | IPermissionRequest[]): Promise<this> {
    if (req instanceof Array) {
      return Promise.all(req.map(r => this.grant(r))).then(() => this);
    }

    const range = getRange(req);
    return this.client.roleGrantPermission({
      name: this.name,
      perm: {
        permType: req.permission,
        key: range.start,
        range_end: range.end,
      },
    })
    .then(() => this);
  }

  /**
   * Returns a list of permissions the role has.
   */
  public permissions(): Promise<IPermissionResult[]> {
    return this.client.roleGet({ role: this.name })
    .then(response => {
      return response.perm.map(perm => ({
        permission: perm.permType,
        range: new Range(perm.key, perm.range_end),
      }));
    });
  }

  /**
   * Grants a user access to the role.
   */
  public addUser(user: string | User): Promise<this> {
    if (user instanceof User) {
      user = user.name;
    }

    return this.client.userGrantRole({ user, role: this.name })
      .then(() => this);
  }

  /**
   * Removes a user's access to the role.
   */
  public removeUser(user: string | User): Promise<this> {
    if (user instanceof User) {
      user = user.name;
    }

    return this.client.userRevokeRole({ name: user, role: this.name })
      .then(() => this);
  }
}

/**
 * The User provides an entry point for managing etcd users. The user can
 * be added to Roles to manage permissions.
 */
export class User {
  constructor(
    private client: AuthClient,
    public readonly name: string,
  ) {}

  /**
   * Creates the user, with the provided password.
   */
  public create(password: string): Promise<this> {
    return this.client.userAdd({ name: this.name, password })
      .then(() => this);
  }

  /**
   * Changes the user's password.
   */
  public setPassword(password: string): Promise<this> {
    return this.client.userChangePassword({ name: this.name, password })
      .then(() => this);
  }

  /**
   * Deletes the user from etcd.
   */
  public delete(): Promise<this> {
    return this.client.userDelete({ name: this.name }).then(() => this);
  }

  /**
   * Returns a list of roles this user has.
   */
  public roles(): Promise<Role[]> {
    return this.client.userGet({ name: this.name }).then(res => {
      return res.roles.map(role => new Role(this.client, role));
    });
  }

  /**
   * Adds the user to a role.
   */
  public addRole(role: string | Role): Promise<this> {
    if (role instanceof Role) {
      role = role.name;
    }

    return this.client.userGrantRole({ user: this.name, role })
      .then(() => this);
  }

  /**
   * Removes the user's access to a role.
   */
  public removeRole(role: string | Role): Promise<this> {
    if (role instanceof Role) {
      role = role.name;
    }

    return this.client.userRevokeRole({ name: this.name, role })
      .then(() => this);
  }
}
